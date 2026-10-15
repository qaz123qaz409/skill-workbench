#!/usr/bin/env python3
"""
iboss_login_service.py - skill-workbench 的 iboss 登录能力本地服务

复刻自 smart-api-chain 的 auto_relogin.py 核心能力：
  1. checkSession 检测 iboss 登录态（/portal/checkSession.json）
  2. session 过期时 CDP 导航 SSO，自动填凭据完成重登录
  3. 凭据加密存储（macOS Keychain / Windows DPAPI / 加密文件兜底）

通过 HTTP API 暴露给前端（仅绑定 127.0.0.1，密码不落盘、不进日志）：
  GET  /api/login/status        检测登录态（可带 ?port=9222）
  POST /api/login/relogin       触发自动重登录 {port?}
  POST /api/login/credentials   保存凭据 {username, password}
  GET  /api/login/credentials   凭据是否已保存（不返回密码）
  POST /api/login/tab           在 CDP 实例打开新标签页 {url, port?}
  GET  /api/health              服务健康检查

用法：
  python3 server/iboss_login_service.py [--port 18890] [--cdp-port 9222]
"""

import argparse
import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ============================================================
# 配置（与 smart-api-chain/auto_relogin.py 保持一致）
# ============================================================

try:
    # 本地私有配置（内网地址/租户默认值，不进 git）；缺省时退回 example 占位值
    import local_settings as _ls
    TARGET_HOST = _ls.TARGET_HOST
    TARGET_HOME_URL = _ls.TARGET_HOME_URL
    TARGET_CHECK_SESSION_PATH = _ls.TARGET_CHECK_SESSION_PATH
    SSO_LOGIN_URL = _ls.SSO_LOGIN_URL
    DEFAULT_TENANT = _ls.DEFAULT_TENANT
    YUQUE_INTERNAL_API_BASE = getattr(_ls, "YUQUE_INTERNAL_API_BASE", "")
    YUQUE_INTERNAL_WEB_BASE = getattr(_ls, "YUQUE_INTERNAL_WEB_BASE", "")
except ImportError:
    # 占位默认值（从 server/local_settings.example.py 复制一份 local_settings.py 即可）
    TARGET_HOST = "iboss.example-internal.com"
    TARGET_HOME_URL = "https://iboss.example-internal.com/portal/dashboard"
    TARGET_CHECK_SESSION_PATH = "/portal/checkSession.json"
    SSO_LOGIN_URL = ("https://sso.example-internal.com/login.htm"
                     "?goto=" + urllib.parse.quote(TARGET_HOME_URL, safe=""))
    DEFAULT_TENANT = "TENANT0001"
    YUQUE_INTERNAL_API_BASE = ""
    YUQUE_INTERNAL_WEB_BASE = ""
SSO_AUTH_MARKER = "auth.htm"  # 统一认证页通用路径；内网精确值在 local_settings.SSO_AUTH_MARKER
try:
    SSO_AUTH_MARKER = _ls.SSO_AUTH_MARKER
except (NameError, AttributeError):
    pass
TENANT_SELECT_SELECTOR = "select.domain-body-input-control-addOns"
DEFAULT_CDP_PORT = 9222

# 端口段起点：每租户唯一绑定一个 CDP 端口（与前端 constants/tenants.ts 同步）
# 用 9301+ 避开 smart-api-chain 的 9222-9232 端口段
PORT_BASE = 9301

# Chrome 可执行文件路径（按平台）
if sys.platform == "darwin":
    CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif sys.platform == "win32":
    CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
else:
    CHROME_PATH = "google-chrome"

# 每租户独立浏览器 profile 目录
PROFILE_BASE_DIR = os.path.join(os.path.expanduser("~"), ".skill_workbench", "chrome-profiles")

# iboss 租户列表（来源：SSO 登录页 tenant 下拉，port 按顺序从 PORT_BASE 递增）
# 真实清单在 local_settings.TENANT_DEFS（不进 git）；缺省为空列表
try:
    _TENANT_DEFS = list(_ls.TENANT_DEFS)
except (NameError, AttributeError):
    _TENANT_DEFS = []

IBOSS_TENANTS = [
    {"value": value, "label": label, "port": PORT_BASE + idx}
    for idx, (value, label) in enumerate(_TENANT_DEFS)
]

TENANT_BY_VALUE = {t["value"]: t for t in IBOSS_TENANTS}
PORT_BY_TENANT = {t["value"]: t["port"] for t in IBOSS_TENANTS}
TENANT_BY_PORT = {t["port"]: t["value"] for t in IBOSS_TENANTS}


def resolve_port(port, tenant):
    """端口决策：显式 port 优先；否则按租户映射；都没有则默认端口。"""
    if port:
        return int(port)
    if tenant and tenant in PORT_BY_TENANT:
        return PORT_BY_TENANT[tenant]
    return DEFAULT_CDP_PORT

# 凭据存储位置（与 auto_relogin.py 共用，技能中台存的凭据这里直接可用）
CRED_DIR = os.path.join(os.path.expanduser("~"), ".smart_api_fetch")
CRED_FILE = os.path.join(CRED_DIR, ".iboss_cred.enc")
CRED_SERVICE = "smart-api-fetch-iboss"


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ============================================================
# 凭据存储（macOS Keychain / Windows DPAPI / 文件兜底）
# ============================================================

def _mac_keychain_get(service, account):
    try:
        r = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
            capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return None


def _mac_keychain_set(service, account, password):
    subprocess.run(["security", "delete-generic-password", "-s", service, "-a", account],
                   capture_output=True)
    r = subprocess.run(
        ["security", "add-generic-password", "-s", service, "-a", account, "-w", password],
        capture_output=True, text=True)
    return r.returncode == 0


def _dpapi_protect(plaintext_bytes):
    import ctypes, ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    inp = DATA_BLOB(len(plaintext_bytes),
                    ctypes.cast(ctypes.create_string_buffer(plaintext_bytes, len(plaintext_bytes)),
                                ctypes.POINTER(ctypes.c_char)))
    out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(inp), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("CryptProtectData failed")
    return ctypes.string_at(out.pbData, out.cbData)


def _dpapi_unprotect(encrypted_bytes):
    import ctypes, ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    inp = DATA_BLOB(len(encrypted_bytes),
                    ctypes.cast(ctypes.create_string_buffer(encrypted_bytes, len(encrypted_bytes)),
                                ctypes.POINTER(ctypes.c_char)))
    out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(inp), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("CryptUnprotectData failed")
    return ctypes.string_at(out.pbData, out.cbData)


def save_credential(username, password):
    """保存凭据。密码只进系统钥匙串，不写明文文件。"""
    payload = json.dumps({"username": username, "password": password}).encode("utf-8")
    os.makedirs(CRED_DIR, exist_ok=True)
    if sys.platform == "darwin":
        meta = json.dumps({"username": username, "store": "keychain",
                           "service": CRED_SERVICE}).encode("utf-8")
        with open(CRED_FILE, "wb") as f:
            f.write(meta)
        try:
            os.chmod(CRED_FILE, 0o600)
        except OSError:
            pass
        return _mac_keychain_set(CRED_SERVICE, username, password)
    elif sys.platform == "win32":
        enc = _dpapi_protect(payload)
        with open(CRED_FILE, "wb") as f:
            f.write(b"DPAPI1" + enc)
        return True
    else:
        with open(CRED_FILE, "wb") as f:
            f.write(b"PLAIN1" + payload)
        try:
            os.chmod(CRED_FILE, 0o600)
        except OSError:
            pass
        return True


def _keychain_find_account(service):
    """无元文件时的回退：直接从 Keychain 查服务条目，返回账号名或 None。"""
    try:
        r = subprocess.run(
            ["security", "find-generic-password", "-s", service],
            capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                if '"acct"' in line:
                    parts = line.split('=', 1)
                    if len(parts) == 2:
                        return parts[1].strip().strip('"')
    except Exception:
        pass
    return None


def load_credential():
    """读取凭据，返回 (username, password) 或 (None, None)。"""
    if not os.path.exists(CRED_FILE):
        # 回退：元文件不存在时直接查 Keychain（兼容技能中台保存的凭据）
        if sys.platform == "darwin":
            account = _keychain_find_account(CRED_SERVICE)
            if account:
                password = _mac_keychain_get(CRED_SERVICE, account)
                if password:
                    return account, password
        return None, None
    try:
        raw = open(CRED_FILE, "rb").read()
        if sys.platform == "darwin":
            meta = json.loads(raw.decode("utf-8"))
            username = meta.get("username", "")
            password = _mac_keychain_get(meta.get("service", CRED_SERVICE), username)
            if password:
                return username, password
            return None, None
        elif raw.startswith(b"DPAPI1"):
            data = json.loads(_dpapi_unprotect(raw[6:]).decode("utf-8"))
            return data.get("username"), data.get("password")
        elif raw.startswith(b"PLAIN1"):
            data = json.loads(raw[6:].decode("utf-8"))
            return data.get("username"), data.get("password")
    except Exception as e:
        log(f"load_credential error: {e}")
    return None, None


def has_credential():
    if not os.path.exists(CRED_FILE):
        if sys.platform == "darwin":
            account = _keychain_find_account(CRED_SERVICE)
            if account:
                ok = _mac_keychain_get(CRED_SERVICE, account) is not None
                return ok, account
        return False, ""
    try:
        raw = open(CRED_FILE, "rb").read()
        if sys.platform == "darwin":
            meta = json.loads(raw.decode("utf-8"))
            user = meta.get("username", "")
            ok = _mac_keychain_get(meta.get("service", CRED_SERVICE), user) is not None
            return ok, user
    except Exception:
        pass
    return True, ""


# ============================================================
# 极简 CDP WebSocket 客户端（移植自 auto_relogin.SimpleWS）
# ============================================================

class SimpleWS:
    def __init__(self, url):
        self.url = url
        self.sock = None

    def connect(self):
        u = urllib.parse.urlparse(self.url)
        host = u.hostname or "127.0.0.1"
        port = u.port or 80
        path = u.path or "/"
        self.sock = socket.create_connection((host, port), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
               f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WS handshake failed")
            resp += chunk

    def send(self, data):
        payload = data.encode("utf-8")
        header = bytearray([0x81])
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _recv_n(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("WS closed")
            buf += chunk
        return buf

    def recv(self, timeout=15):
        self.sock.settimeout(timeout)
        b1, b2 = self._recv_n(2)
        opcode = b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._recv_n(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._recv_n(8))[0]
        payload = self._recv_n(n) if n else b""
        if opcode == 0x8:
            raise ConnectionError("WS closed by peer")
        return payload.decode("utf-8", errors="replace")

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


def cdp_call(ws, msg_id_counter, method, params=None, timeout=20):
    msg_id_counter[0] += 1
    mid = msg_id_counter[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            msg = json.loads(ws.recv(timeout=max(1, deadline - time.time())))
        except socket.timeout:
            continue
        except ConnectionError:
            return None
        if msg.get("id") == mid:
            return msg
    return None


# ============================================================
# 登录态检测（checkSession.json）
# ============================================================

CHECK_SESSION_JS = """(async function() {
    try {
        var ctokenMatch = document.cookie.match(/ctoken=([^;]+)/);
        if (!ctokenMatch) return JSON.stringify({logged_in: false, reason: "no_ctoken"});
        var ctoken = ctokenMatch[1];
        var resp = await fetch(
            "https://__TARGET_HOST__/__CHECK_PATH__?ctoken=" + ctoken,
            {credentials: "include"}
        );
        var data = await resp.json();
        if (data.authToken && data.authToken.loginUser) {
            return JSON.stringify({
                logged_in: true,
                user: data.authToken.loginUser.operatorName,
                tenant: data.authToken.tntInstId || "unknown"
            });
        }
        return JSON.stringify({logged_in: false, reason: "no_auth_in_response"});
    } catch(e) {
        return JSON.stringify({logged_in: false, reason: e.message});
    }
})()""".replace("__TARGET_HOST__", TARGET_HOST).replace(
    "__CHECK_PATH__", TARGET_CHECK_SESSION_PATH.lstrip("/"))


def get_page_tabs(port):
    try:
        raw = urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=3).read()
        return [t for t in json.loads(raw)
                if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
    except Exception:
        return []


def find_iboss_tab(port):
    tabs = get_page_tabs(port)
    for t in tabs:
        if TARGET_HOST in (t.get("url") or ""):
            return t
    return tabs[0] if tabs else None


def check_login_status(port):
    """返回 {logged_in, user, tenant, detail}"""
    tab = find_iboss_tab(port)
    if not tab:
        return {"logged_in": False, "detail": "no_tab", "port": port}
    ws = SimpleWS(tab["webSocketDebuggerUrl"])
    try:
        ws.connect()
        mid = [0]
        # 若 tab 不在 iboss 域，先导航过去再检测
        if TARGET_HOST not in (tab.get("url") or ""):
            cdp_call(ws, mid, "Page.navigate", {"url": TARGET_HOME_URL}, timeout=15)
            time.sleep(5)
        resp = cdp_call(ws, mid, "Runtime.evaluate", {
            "expression": CHECK_SESSION_JS,
            "returnByValue": True,
            "awaitPromise": True,
        })
        if resp:
            value = resp.get("result", {}).get("result", {}).get("value", "")
            if value:
                data = json.loads(value)
                return {"logged_in": bool(data.get("logged_in")),
                        "user": data.get("user", ""),
                        "tenant": data.get("tenant", ""),
                        "port": port}
    except Exception as e:
        return {"logged_in": False, "detail": f"error: {e}", "port": port}
    finally:
        ws.close()
    return {"logged_in": False, "detail": "no_response", "port": port}


# ============================================================
# SSO 自动重登录（移植 auto_relogin.do_sso_relogin 核心流程）
# ============================================================

def _find_auth_frame_ctx(ws, msg_id):
    """在页面 frame 树中找企业统一认证 auth.htm iframe，返回 (frameId, contextId)"""
    tree = cdp_call(ws, msg_id, "Page.getFrameTree", {})
    if not tree:
        return None, None
    target = None

    def walk(node):
        nonlocal target
        fr = node.get("frame", {})
        # 统一认证 iframe 路径标记（内网真实值在 local_settings.SSO_AUTH_MARKER）
        if SSO_AUTH_MARKER in fr.get("url", ""):
            target = fr.get("id")
        for c in node.get("childFrames", []):
            walk(c)

    walk(tree.get("result", {}).get("frameTree", {}))
    if not target:
        return None, None
    r = cdp_call(ws, msg_id, "Page.createIsolatedWorld",
                 {"frameId": target, "worldName": "relogin"})
    ctx = (r or {}).get("result", {}).get("executionContextId")
    return target, ctx


def _eval_in_ctx(ws, msg_id, ctx, js, timeout=15):
    resp = cdp_call(ws, msg_id, "Runtime.evaluate", {
        "expression": js, "contextId": ctx,
        "returnByValue": True, "awaitPromise": False,
    }, timeout=timeout)
    if resp:
        return resp.get("result", {}).get("result", {}).get("value", "")
    return ""


def do_sso_relogin(port, tenant=DEFAULT_TENANT):
    """完整重登录流程。返回 {success, user, tenant, message}"""
    stored_user, stored_pass = load_credential()
    if not stored_user or not stored_pass:
        return {"success": False, "message": "凭据未保存，请先在设置页保存工号和密码"}

    tab = find_iboss_tab(port)
    if not tab:
        return {"success": False, "message": "CDP 实例无可用标签页，请先启动 Debug Chrome"}

    ws = SimpleWS(tab["webSocketDebuggerUrl"])
    try:
        ws.connect()
    except Exception as e:
        return {"success": False, "message": f"CDP 连接失败: {e}"}

    msg_id = [0]
    cdp_call(ws, msg_id, "Page.enable", {})
    log(f"relogin: navigating to SSO (tenant={tenant})")
    cdp_call(ws, msg_id, "Page.navigate", {"url": SSO_LOGIN_URL}, timeout=20)

    # 1) 等 Kerberos 自动认证；若 8s 内跳回 iboss 则无需填表
    for _ in range(4):
        time.sleep(2)
        st = check_login_status(port)
        if st.get("logged_in"):
            ws.close()
            return {"success": True, "user": st.get("user"), "tenant": st.get("tenant"),
                    "message": "Kerberos/SSO 自动认证成功"}

    # 2) 等 auth iframe 渲染
    auth_ctx = None
    for attempt in range(1, 13):
        _fid, auth_ctx = _find_auth_frame_ctx(ws, msg_id)
        if auth_ctx:
            break
        time.sleep(1.5)
    if not auth_ctx:
        ws.close()
        return {"success": False, "message": "未找到 SSO 认证 iframe（页面可能被二次验证拦截）"}

    # 3) 轮询等租户选项异步加载（复刻版修复了单次检查的竞态）
    check_js = """
    (function(){
        var sel = document.querySelector('%s');
        if (!sel) return JSON.stringify({found:false, count:0});
        var idx = -1;
        for (var i=0;i<sel.options.length;i++){
            if (sel.options[i].value === '%s'){ idx=i; break; }
        }
        return JSON.stringify({found: idx>=0, count: sel.options.length});
    })()
    """ % (TENANT_SELECT_SELECTOR, tenant)
    found = False
    for _ in range(20):
        val = _eval_in_ctx(ws, msg_id, auth_ctx, check_js)
        try:
            data = json.loads(val) if val else {}
        except Exception:
            data = {}
        if data.get("found"):
            found = True
            break
        time.sleep(1.5)
    if not found:
        ws.close()
        return {"success": False,
                "message": f"租户 '{tenant}' 不在可选列表（options={data.get('count', 0)}）"}

    # 4) 原子提交：租户 + 工号 + 密码 + 点击登录
    escaped_user = stored_user.replace("\\", "\\\\").replace("'", "\\'")
    escaped_pass = stored_pass.replace("\\", "\\\\").replace("'", "\\'")
    submit_js = """
    (function(){
        try {
            var inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            var selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            var sel = document.querySelector('%s');
            selectSetter.call(sel, '%s');
            sel.dispatchEvent(new Event('input', {bubbles:true}));
            sel.dispatchEvent(new Event('change', {bubbles:true}));
            var pwd = document.querySelector('input.domain-body-input-control-userpass[type="password"]')
                   || document.querySelector('input[name="userpass"][type="password"]')
                   || document.querySelector('input[type="password"]');
            var user = document.querySelector('input.domain-body-input-control-username')
                    || document.querySelector('input[name="username"]')
                    || document.querySelector('input[name="loginName"]');
            if (!user) return JSON.stringify({ok:false, error:'no_username_input'});
            if (!pwd) return JSON.stringify({ok:false, error:'no_password_input'});
            inputSetter.call(user, '%s');
            user.dispatchEvent(new Event('input', {bubbles:true}));
            user.dispatchEvent(new Event('change', {bubbles:true}));
            inputSetter.call(pwd, '%s');
            pwd.dispatchEvent(new Event('input', {bubbles:true}));
            pwd.dispatchEvent(new Event('change', {bubbles:true}));
            var btn = document.querySelector('a.submit.domain-body-submit-control-submit')
                   || document.querySelector('a[class*="domain-body-submit-control-submit"]');
            if (!btn) {
                var form = pwd.closest('form');
                if (form) { form.submit(); return JSON.stringify({ok:true, method:'form'}); }
                return JSON.stringify({ok:false, error:'no_submit_button'});
            }
            btn.click();
            return JSON.stringify({ok:true, method:'click'});
        } catch(e) { return JSON.stringify({ok:false, error:e.message}); }
    })()
    """ % (TENANT_SELECT_SELECTOR, tenant, escaped_user, escaped_pass)
    log(f"relogin: submitting login form (user={stored_user})")
    submit_val = _eval_in_ctx(ws, msg_id, auth_ctx, submit_js, timeout=20)
    try:
        submit_data = json.loads(submit_val) if submit_val else {}
    except Exception:
        submit_data = {}
    ws.close()
    if not submit_data.get("ok"):
        return {"success": False,
                "message": f"提交登录表单失败: {submit_data.get('error', 'unknown')}"}

    # 5) 轮询验证登录成功（最长 30s）
    start = time.time()
    while time.time() - start < 30:
        time.sleep(3)
        st = check_login_status(port)
        if st.get("logged_in"):
            return {"success": True, "user": st.get("user"), "tenant": st.get("tenant"),
                    "message": "登录成功"}
    return {"success": False, "message": "已提交登录表单，但 30s 内未检测到登录态（可能触发二次验证，请人工处理）"}


def open_tab(port, url):
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/json/new?{url}", method="PUT")
        raw = urllib.request.urlopen(req, timeout=5).read()
        return json.loads(raw)
    except Exception:
        try:  # 旧版 Chrome 用 GET
            raw = urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/new?{url}", timeout=5).read()
            return json.loads(raw)
        except Exception as e:
            return {"error": str(e)}


# ============================================================
# CDP 实例管理（每租户一个 Chrome 实例，端口唯一绑定）
# ============================================================

def is_cdp_alive(port, timeout=1.0):
    """快速探测指定端口是否有 CDP 实例在跑。"""
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout)
        return True
    except Exception:
        return False


def list_instances():
    """并发探测全部 42 个租户端口的运行状态。"""
    from concurrent.futures import ThreadPoolExecutor
    tenants = IBOSS_TENANTS
    with ThreadPoolExecutor(max_workers=16) as pool:
        alive_flags = list(pool.map(lambda t: is_cdp_alive(t["port"]), tenants))
    return [
        {"tenant": t["value"], "label": t["label"], "port": t["port"],
         "running": bool(flag)}
        for t, flag in zip(tenants, alive_flags)
    ]


def start_instance(tenant):
    """为指定租户启动独立 Chrome 实例（专属 profile + 专属端口）。
    返回 {success, port, message}"""
    if tenant not in TENANT_BY_VALUE:
        return {"success": False, "message": f"未知租户: {tenant}"}
    port = PORT_BY_TENANT[tenant]
    if is_cdp_alive(port, timeout=1.0):
        return {"success": True, "port": port, "message": "实例已在运行"}

    profile_dir = os.path.join(PROFILE_BASE_DIR, tenant)
    os.makedirs(profile_dir, exist_ok=True)
    if not os.path.exists(CHROME_PATH):
        return {"success": False, "message": f"未找到 Chrome: {CHROME_PATH}"}

    log(f"instance: starting Chrome for {tenant} on port {port}")
    try:
        subprocess.Popen(
            [CHROME_PATH,
             f"--remote-debugging-port={port}",
             f"--user-data-dir={profile_dir}",
             "--no-first-run", "--no-default-browser-check",
             TARGET_HOME_URL],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
    except Exception as e:
        return {"success": False, "message": f"启动失败: {e}"}

    # 等 CDP 就绪（最长 20s）
    for _ in range(40):
        time.sleep(0.5)
        if is_cdp_alive(port, timeout=1.0):
            return {"success": True, "port": port, "message": "实例已启动"}
    return {"success": False, "port": port, "message": "启动超时（20s 内 CDP 未就绪）"}


def stop_instance(port):
    """通过 CDP Browser.close 关闭指定端口的实例。"""
    tabs = get_page_tabs(port)
    if not tabs:
        return {"success": False, "message": "端口上没有运行中的实例"}
    try:
        ws = SimpleWS(tabs[0]["webSocketDebuggerUrl"])
        ws.connect()
        cdp_call(ws, [0], "Browser.close", {}, timeout=10)
        ws.close()
    except Exception as e:
        return {"success": False, "message": f"关闭失败: {e}"}
    # 验证已关闭
    for _ in range(10):
        time.sleep(0.5)
        if not is_cdp_alive(port, timeout=1.0):
            return {"success": True, "message": "实例已停止"}
    return {"success": True, "message": "已发送关闭指令（请确认浏览器窗口已退出）"}


# ============================================================
# Cockpit AI Bridge（对接 Cockpit 内置 chat RPC）
#
# 机制：Cockpit 启动时把 {port, token} 写入 handshake 文件
#   ~/.openclaw-bundle/app-tool-bridge.json（随后会被它自己的 runtime 消费删除）
# 这里后台线程持续监视该文件，一出现立即读取并缓存，
# 之后用 Bearer token 调 http://127.0.0.1:{port}/rpc 的 chat.send 等方法。
# ============================================================

HANDSHAKE_PATH = os.path.join(os.path.expanduser("~"), ".openclaw-bundle", "app-tool-bridge.json")
BRIDGE_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".skill_workbench", "cockpit-bridge.json")

_bridge_conn = None          # {"port": int, "token": str}
_bridge_lock = threading.Lock()


def _save_bridge_cache(conn):
    try:
        os.makedirs(os.path.dirname(BRIDGE_CACHE_PATH), exist_ok=True)
        with open(BRIDGE_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(conn, f)
        os.chmod(BRIDGE_CACHE_PATH, 0o600)
    except Exception as e:
        log(f"bridge: cache save failed: {e}")


def _load_bridge_cache():
    try:
        with open(BRIDGE_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def get_bridge_conn():
    with _bridge_lock:
        if _bridge_conn:
            return _bridge_conn
    return _load_bridge_cache()


def bridge_alive(conn):
    """用缓存的连接打一次 /health 验证有效性。"""
    if not conn or not conn.get("port"):
        return False
    try:
        urllib.request.urlopen(
            f"http://127.0.0.1:{conn['port']}/health", timeout=2)
        return True
    except Exception:
        return False


def bridge_watcher():
    """后台线程：监视 handshake 文件，捕获 Cockpit 的 RPC 端口与 token。"""
    global _bridge_conn
    while True:
        try:
            if os.path.exists(HANDSHAKE_PATH):
                with open(HANDSHAKE_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("port") and data.get("token"):
                    conn = {"port": int(data["port"]), "token": data["token"]}
                    with _bridge_lock:
                        changed = _bridge_conn != conn
                        _bridge_conn = conn
                    if changed:
                        _save_bridge_cache(conn)
                        log(f"bridge: captured handshake -> port={conn['port']}")
        except Exception as e:
            log(f"bridge: watcher error: {e}")
        time.sleep(0.1)


def rpc_call(method, params=None, timeout=300):
    """调用 Cockpit RPC。返回 {ok, data?, error?}。"""
    conn = get_bridge_conn()
    if not conn:
        return {"ok": False, "error": {
            "code": "E_NO_BRIDGE",
            "message": "未捕获 Cockpit 连接（handshake），请重启 Cockpit 后重试"}}
    body = json.dumps({"id": str(int(time.time() * 1000)),
                       "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{conn['port']}/rpc",
        data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {conn['token']}"},
        method="POST")
    try:
        raw = urllib.request.urlopen(req, timeout=timeout).read()
        return json.loads(raw)
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": {"code": "E_HTTP", "message": str(e)}}
    except Exception as e:
        return {"ok": False, "error": {"code": "E_NETWORK", "message": str(e)}}


def chat_send(message, session_id=None):
    """向 Cockpit AI 发一条消息（同步等完整回复，自动带人设上下文）。"""
    params = {"prompt": message}
    if session_id:
        params["sessionId"] = session_id
    resp = rpc_call("chat.send", params)
    if not resp.get("ok"):
        return {"success": False,
                "message": (resp.get("error") or {}).get("message", "RPC 调用失败")}
    data = resp.get("data") or {}
    if not data.get("success", True):
        return {"success": False, "sessionId": data.get("sessionId"),
                "message": data.get("error") or "AI 回复失败"}
    return {"success": True,
            "reply": data.get("responseText") or data.get("resultText") or "",
            "sessionId": data.get("sessionId"),
            "engine": data.get("engine"),
            "durationMs": data.get("durationMs")}


# ---- 直连模型 API（复用 Cockpit 已存的 Provider 凭据，无需 handshake）----

PROVIDER_STORE = os.path.join(
    os.path.expanduser("~"), "Library", "Application Support",
    "cockpit-desktop", "providers", "provider-store.json")
PROVIDER_SECRETS = os.path.join(
    os.path.expanduser("~"), "Library", "Application Support",
    "cockpit-desktop", "providers", "provider-secrets.json")


def load_model_api_config():
    """从 Cockpit 的 provider 存储读取 baseUrl/apiKey/model（用户无需手动配置）。"""
    try:
        with open(PROVIDER_STORE, "r", encoding="utf-8") as f:
            store = json.load(f)
        with open(PROVIDER_SECRETS, "r", encoding="utf-8") as f:
            secrets = json.load(f)
        provider = (store.get("providers") or [None])[0]
        if not provider:
            return None
        base_url = (provider.get("endpoint") or {}).get("baseUrl")
        secret_ref = (provider.get("credential") or {}).get("secretRef")
        if not base_url or not secret_ref:
            return None
        secret = (secrets.get("secrets") or {}).get(secret_ref)
        if not secret:
            return None
        api_key = secret["value"]
        if secret.get("encoding") == "plain-base64":
            api_key = base64.b64decode(api_key).decode()
        model = provider.get("defaultModelKey") or ""
        model = model.split("/", 1)[-1]  # custom-antglobal-cloud/CLAW-AUTO -> CLAW-AUTO
        return {"baseUrl": base_url, "apiKey": api_key, "model": model}
    except Exception as e:
        log(f"model-api: load config failed: {e}")
        return None


def _strip_think(text):
    """去掉回复中的 <think>...</think> 思考块。"""
    import re
    return re.sub(r"<think>[\s\S]*?</think>\s*", "", text or "").strip()


def direct_chat(messages):
    """直连 OpenAI 兼容模型网关（SSE 流式，聚合为完整回复）。"""
    cfg = load_model_api_config()
    if not cfg:
        return {"success": False, "message": "未找到 Cockpit Provider 凭据，请先在 Cockpit 里配置模型"}
    body = json.dumps({
        "model": cfg["model"],
        "messages": messages,
        "stream": True,
    }).encode()
    req = urllib.request.Request(
        cfg["baseUrl"].rstrip("/") + "/chat/completions", data=body,
        headers={"Authorization": f"Bearer {cfg['apiKey']}",
                 "Content-Type": "application/json"},
        method="POST")
    started = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode()[:300]
        except Exception:
            detail = str(e)
        return {"success": False, "message": f"模型网关 HTTP {e.code}: {detail}"}
    except Exception as e:
        return {"success": False, "message": f"模型网关请求失败: {e}"}

    parts = []
    try:
        for raw in resp:
            line = raw.decode("utf-8", errors="ignore").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except Exception:
                continue
            delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
            if delta.get("content"):
                parts.append(delta["content"])
            if chunk.get("finished"):
                break
    finally:
        resp.close()
    reply = _strip_think("".join(parts))
    if not reply:
        return {"success": False, "message": "模型未返回内容"}
    return {"success": True, "reply": reply, "mode": "direct",
            "model": cfg["model"], "durationMs": int((time.time() - started) * 1000)}


def _kb_recall_for_chat(message, topk=3):
    """对话前置召回：用编译知识库的双层索引检索相关知识。"""
    r = kb_search(message, topk)
    return (r.get("hits") or []) if r.get("success") else []


def _build_rag_context(hits):
    """把召回结果拼成知识上下文块（格式与人设中的 llm-wiki 召回约定一致：
    【知识N】《主题》标题 → 主题背景 + 答案原文）。"""
    blocks = []
    for i, h in enumerate(hits, 1):
        part = f"【知识{i}】《{h.get('topic') or '未分类'}》 {h.get('title')}\n"
        if h.get("topic_overview"):
            part += f"主题背景（文章概述）: {h['topic_overview'][:200]}\n"
        part += f"答案原文（切片 content）: {h.get('content') or ''}"
        blocks.append(part)
    return ("以下是从客服知识库（llm-wiki 编译产物）双层召回的知识块，"
            "请严格依据这些知识回答：可口语化改写但关键信息（链接/步骤/材料/参数）一字不丢；"
            "知识间有冲突时并列两种说法禁止静默择一；知识未覆盖则如实说明，不要编造；"
            "回答末尾用一行列出引用的知识（《主题》标题）：\n\n"
            + "\n\n".join(blocks))


def _kb_sources(hits):
    """精简的引用来源列表，随回复返回给前端展示。"""
    return [{"title": h.get("title"), "topic": h.get("topic"),
             "slice_id": h.get("slice_id")} for h in hits]


def _wf_history_text(history):
    """对话历史 → 文本，供工作流引擎从历史轮次提取参数（如第二轮才给的商户 ID）。"""
    lines = []
    for m in (history or [])[-10:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            who = "用户" if m["role"] == "user" else "助手"
            lines.append(f"{who}：{str(m['content'])[:500]}")
    return "\n".join(lines)


def chat_send_auto(message, session_id=None, history=None):
    """对话主入口：工作流路由优先（含会话粘滞续接）→ 编译知识库召回 → 注入上下文 →
    bridge 可用走完整 Agent（Cockpit 生成答案）；否则直连模型 API。"""
    wf = _wf_match(message)
    if not wf and session_id:
        pinned = WORKFLOW_SESSIONS.get(session_id)
        if pinned:
            wf = next((w for w in _workflows_load().get("workflows", [])
                       if w.get("id") == pinned), None)
    if wf:
        if session_id:
            WORKFLOW_SESSIONS[session_id] = wf.get("id")
        user_input = {"用户问题": message}
        ht = _wf_history_text(history)
        if ht:
            user_input["对话历史"] = ht
        out = _workflow_run_sync(wf, user_input)
        reply = (out.get("conclusion") or f"工作流执行异常：{out.get('error')}")
        reply += f"\n\n（由工作流「{wf.get('name')}」产出，共 {len(out.get('trace') or [])} 步）"
        log(f"chat: workflow routed -> {wf.get('name')}")
        return {"success": True, "reply": reply, "mode": "workflow",
                "sources": [{"topic": "工作流", "title": wf.get("name"),
                             "slice_id": wf.get("id")}]}
    raw_hits = _kb_recall_for_chat(message)
    # 置信度门槛：得分 + 词元覆盖率双条件，拦住「只命中通用词」的伪相关；
    # 无有效命中 → 记未覆盖待办（知识缺口自动进维护队列）
    hits = [h for h in raw_hits
            if (h.get("score") or 0) >= 2.0 and (h.get("coverage") or 0) >= 0.3]
    if not hits:
        kb_maintenance_add_uncovered(message)  # 未覆盖问题自动进维护待办
    rag_ctx = _build_rag_context(hits) if hits else ""
    enriched = (rag_ctx + "\n\n用户问题：" + message) if rag_ctx else message
    if hits:
        log(f"chat: kb recall {len(hits)} hits -> "
            + ", ".join(h.get("topic") or "-" for h in hits))
    conn = get_bridge_conn()
    if conn and bridge_alive(conn):
        result = chat_send(enriched, session_id)
        if result.get("success"):
            result["mode"] = "agent"
            if result.get("reply"):
                result["reply"] = _strip_think(result["reply"])
            result["sources"] = _kb_sources(hits)
            return result
        # bridge 调用失败时降级直连
        log(f"chat: bridge failed, fallback to direct: {result.get('message')}")
    # 直连：本地维护历史 + 注入人设作为 system
    messages = []
    persona = read_persona_section()
    if persona:
        messages.append({"role": "system", "content": persona})
    for m in (history or [])[-20:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": enriched})
    result = direct_chat(messages)
    if result.get("success"):
        result["sources"] = _kb_sources(hits)
    return result


def restart_cockpit_for_bridge():
    """重启 Cockpit 以重新生成 handshake（新 token 无法从运行中的进程获取）。
    用 COCKPIT_API_SERVER=1 启动，强制开启 API Server 模式写 handshake 文件。"""
    app = LAUNCHABLE_APPS.get("cockpit")
    if not app:
        return {"success": False, "message": "cockpit 应用未配置"}
    exe = os.path.join(app["path"], "Contents", "MacOS", "Cockpit")
    if get_app_status("cockpit")["running"]:
        subprocess.run(["osascript", "-e", 'tell application "Cockpit" to quit'],
                       check=False)
        for _ in range(20):
            time.sleep(0.5)
            if not get_app_status("cockpit")["running"]:
                break
    # 直接拉起可执行文件并注入环境变量（open -a 不支持传 env）
    env = dict(os.environ, COCKPIT_API_SERVER="1")
    subprocess.Popen([exe], env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    log("app: relaunched Cockpit with COCKPIT_API_SERVER=1")
    # 等 handshake 被 watcher 捕获（最长 30s）
    for _ in range(60):
        time.sleep(0.5)
        conn = get_bridge_conn()
        if conn and bridge_alive(conn):
            return {"success": True, "port": conn["port"],
                    "message": "Cockpit 已重启，AI 连接已建立"}
    return {"success": False,
            "message": "Cockpit 已启动但未捕获到连接（handshake 可能被其它 runtime 抢先消费，请重试）"}


# ============================================================
# Cockpit 人设同步（写入 claude-runtime workspace 的 CLAUDE.md）
# ============================================================

COCKPIT_WORKSPACE = os.path.join(
    os.path.expanduser("~"),
    "Library", "Application Support", "cockpit-desktop",
    "claude-runtime", "workspace")
CLAUDE_MD = os.path.join(COCKPIT_WORKSPACE, "CLAUDE.md")
PERSONA_START = "<!-- skill-workbench:persona:start -->"
PERSONA_END = "<!-- skill-workbench:persona:end -->"


def read_persona_section():
    """读取 CLAUDE.md 中人设标记块的内容（不存在返回 None）。"""
    if not os.path.exists(CLAUDE_MD):
        return None
    try:
        with open(CLAUDE_MD, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return None
    start = text.find(PERSONA_START)
    end = text.find(PERSONA_END)
    if start < 0 or end < 0 or end < start:
        return None
    return text[start + len(PERSONA_START):end].strip()


def sync_persona(content):
    """把人设写入 CLAUDE.md 的标记块（幂等：已有则替换，没有则追加）。
    返回 {success, path, message}"""
    content = (content or "").strip()
    if not content:
        return {"success": False, "message": "人设内容不能为空"}
    try:
        os.makedirs(COCKPIT_WORKSPACE, exist_ok=True)
        existing = ""
        if os.path.exists(CLAUDE_MD):
            with open(CLAUDE_MD, "r", encoding="utf-8") as f:
                existing = f.read()

        block = f"{PERSONA_START}\n{content}\n{PERSONA_END}\n"
        start = existing.find(PERSONA_START)
        end = existing.find(PERSONA_END)
        if start >= 0 and end > start:
            # 替换已有标记块
            new_text = existing[:start] + block + existing[end + len(PERSONA_END):].lstrip("\n")
        else:
            # 追加（保留已有内容，空行隔开）
            new_text = existing.rstrip("\n")
            if new_text:
                new_text += "\n\n"
            new_text += block

        with open(CLAUDE_MD, "w", encoding="utf-8") as f:
            f.write(new_text)
        log(f"persona: synced {len(content)} chars -> {CLAUDE_MD}")
        return {"success": True, "path": CLAUDE_MD,
                "message": "人设已同步到 Cockpit 工作区（CLAUDE.md）"}
    except Exception as e:
        return {"success": False, "message": f"同步失败: {e}"}


# ============================================================
# 本地应用唤起（白名单制，不接受任意命令）
# ============================================================

LAUNCHABLE_APPS = {
    "cockpit": {"name": "GenAI Cockpit 桌面版", "path": "/Applications/Cockpit.app"},
}


def get_app_status(app_key):
    """检测应用是否在运行 + 路径是否存在。"""
    app = LAUNCHABLE_APPS.get(app_key)
    if not app:
        return {"running": False, "installed": False, "message": f"未知应用: {app_key}"}
    installed = os.path.exists(app["path"])
    running = False
    if sys.platform == "darwin":
        proc = subprocess.run(
            ["pgrep", "-f", f"{app['path']}/Contents/MacOS"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        running = proc.returncode == 0
    return {"running": running, "installed": installed}


def launch_app(app_key):
    """通过命令行唤起本地应用（macOS: open -a，Win: start）。"""
    app = LAUNCHABLE_APPS.get(app_key)
    if not app:
        return {"success": False, "message": f"未知应用: {app_key}"}
    if not os.path.exists(app["path"]):
        return {"success": False, "message": f"未安装: {app['path']}"}

    status = get_app_status(app_key)
    if status["running"]:
        # 已在运行：带到前台
        if sys.platform == "darwin":
            subprocess.run(["open", app["path"]], check=False)
        return {"success": True, "already_running": True,
                "message": f"{app['name']}已在运行，已带到前台"}

    log(f"app: launching {app['name']} -> {app['path']}")
    try:
        if sys.platform == "darwin":
            if app_key == "cockpit":
                # 直接拉起可执行文件并注入 COCKPIT_API_SERVER=1，
                # 启动即写 handshake，AI 对话可走 Agent 模式（open -a 不支持传 env）
                exe = os.path.join(app["path"], "Contents", "MacOS", "Cockpit")
                env = dict(os.environ, COCKPIT_API_SERVER="1")
                subprocess.Popen([exe], env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
            else:
                subprocess.Popen(["open", app["path"]],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "win32":
            os.startfile(app["path"])  # noqa
        else:
            return {"success": False, "message": "当前平台不支持唤起桌面应用"}
    except Exception as e:
        return {"success": False, "message": f"唤起失败: {e}"}

    # 等进程就绪（最长 15s）
    for _ in range(15):
        time.sleep(1)
        if get_app_status(app_key)["running"]:
            return {"success": True, "message": f"{app['name']}已启动"}
    return {"success": True, "message": "已发送启动命令（进程尚未探测到，可能启动较慢）"}


# ============================================================
# 编译知识库（kb-compiler 产物：主题文档 + 双层召回索引）
# ============================================================

KB_OUT_DIR = os.environ.get(
    "KB_OUT_DIR",
    os.path.expanduser("~/Downloads/ai-im/qoder/kb-compiler/kb_out"))

# smart-api-chain 业务模板索引（供技能列表页展示）
SMART_CHAIN_INDEX = os.path.expanduser(
    "~/Downloads/smart-api-chain 2/chains/INDEX.json")


def smart_chain_templates():
    """读 smart-api-chain 的 INDEX.json，返回业务查询模板清单（名称/意图/入参/触发词）。"""
    try:
        with open(SMART_CHAIN_INDEX, encoding="utf-8") as f:
            idx = json.load(f)
    except Exception as e:
        return {"success": False, "message": str(e), "count": 0, "templates": []}
    items = idx.get("chains") or idx.get("templates") or []

    def _pname(p):
        return (p.get("name") or str(p)) if isinstance(p, dict) else str(p)

    def _pdesc(p):
        return (p.get("description") or "") if isinstance(p, dict) else ""

    out = []
    for t in items:
        out.append({
            "name": t.get("name", ""),
            "intent": t.get("intent", ""),
            "custom": bool(t.get("custom")),
            "input_required": [{"name": _pname(p), "description": _pdesc(p)}
                               for p in t.get("input_required", [])],
            "trigger_keywords": t.get("trigger_keywords", []),
            "sample_questions": (t.get("sample_questions") or [])[:2],
        })
    return {"success": True, "count": len(out), "templates": out}


def smart_chain_template_detail(name):
    """按名称读 smart-api-chain 模板 JSON 全文（供前端预览）。"""
    try:
        with open(SMART_CHAIN_INDEX, encoding="utf-8") as f:
            idx = json.load(f)
    except Exception as e:
        return {"success": False, "message": str(e)}
    items = idx.get("chains") or idx.get("templates") or []
    hit = next((t for t in items if t.get("name") == name), None)
    if not hit:
        return {"success": False, "message": f"模板不存在: {name}"}
    root = os.path.dirname(os.path.dirname(SMART_CHAIN_INDEX))  # smart-api-chain 根目录
    path = os.path.join(root, hit.get("template_path", ""))
    try:
        with open(path, encoding="utf-8") as f:
            tpl = json.load(f)
    except Exception as e:
        return {"success": False, "message": str(e)}
    return {"success": True, "path": hit.get("template_path"), "template": tpl,
            "custom": bool(hit.get("custom"))}


def _smart_chain_index_load():
    with open(SMART_CHAIN_INDEX, encoding="utf-8") as f:
        idx = json.load(f)
    key = "chains" if "chains" in idx else "templates"
    return idx, key


def smart_chain_save_template(template):
    """用户自建业办技能：写 chains/业务模板/<name>.json 并 upsert INDEX.json（custom 标记）。"""
    if not isinstance(template, dict):
        return {"success": False, "message": "template 必须是 JSON 对象"}
    name = (template.get("name") or "").strip()
    if not name:
        return {"success": False, "message": "模板名称必填"}
    if any(c in name for c in "/\\:.?*\"<>|") or name in (".", ".."):
        return {"success": False, "message": "名称含非法字符"}
    if not template.get("steps"):
        return {"success": False, "message": "至少需要一个执行步骤"}
    root = os.path.dirname(os.path.dirname(SMART_CHAIN_INDEX))
    rel = f"chains/业务模板/{name}.json"
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    template.setdefault("version", "1.0.0")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(template, f, ensure_ascii=False, indent=2)
    idx, key = _smart_chain_index_load()
    items = idx.setdefault(key, [])
    meta = template.get("metadata") or {}

    def _params(required):
        out = []
        for k, v in (template.get("input") or {}).items():
            desc = v.get("description", "") if isinstance(v, dict) else ""
            if bool(isinstance(v, dict) and v.get("required")) == required:
                out.append({"name": k, "description": desc})
        return out

    entry = {
        "name": name,
        "template_path": rel,
        "intent": meta.get("intent_summary") or template.get("description") or "",
        "input_required": _params(True),
        "input_optional": _params(False),
        "trigger_keywords": meta.get("trigger_keywords") or [],
        "sample_questions": meta.get("sample_questions") or [],
        "do_not_use_when": meta.get("do_not_use_when") or [],
        "custom": True,
    }
    for i, t in enumerate(items):
        if t.get("name") == name:
            entry = {**t, **entry}  # 保留旧条目额外字段
            items[i] = entry
            break
    else:
        items.append(entry)
    with open(SMART_CHAIN_INDEX, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)
    return {"success": True, "name": name, "path": rel}


# ------------------------------------------------------------
# 抓包侦探（smart-api-chain wizard）异步任务
# ------------------------------------------------------------
DETECT_JOBS = {}


def smart_chain_detect_start(params):
    """启动 wizard 抓包：浏览器侦听 → 分析 → 生成 chain 草稿（异步 job）。"""
    import threading
    import tempfile
    import uuid
    want = (params.get("want") or "").strip()
    if not want:
        return {"success": False, "message": "期望字段必填"}
    root = os.path.dirname(os.path.dirname(SMART_CHAIN_INDEX))
    script = os.path.join(root, "assets", "build_chain.py")
    if not os.path.exists(script):
        return {"success": False, "message": f"找不到 {script}"}
    wait = int(params.get("wait") or 30)
    out_path = os.path.join(tempfile.mkdtemp(prefix="sw_detect_"), "draft.json")
    cmd = [sys.executable, "-u", script, "wizard",
           "--want", want, "--out", out_path,
           "--known", params.get("known") or "",
           "--wait", str(wait),
           "--name", params.get("name") or "",
           "--description", params.get("description") or "",
           "--domain", params.get("domain") or "",
           "--method", params.get("method") or ""]
    if (params.get("url") or "").strip():
        cmd += ["--url", params["url"].strip()]
    job = uuid.uuid4().hex[:8]
    state = {"status": "running", "logs": [], "draft": None,
             "error": "", "out_path": out_path}
    DETECT_JOBS[job] = state

    def _run():
        try:
            p = subprocess.Popen(cmd, cwd=root, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1)
            for line in p.stdout:
                state["logs"].append(line.rstrip("\n"))
            p.wait(timeout=wait + 180)
            if os.path.exists(out_path):
                with open(out_path, encoding="utf-8") as f:
                    state["draft"] = json.load(f)
                state["status"] = "done"
            else:
                state["status"] = "error"
                state["error"] = "wizard 未生成草稿，请查看日志"
        except Exception as e:
            state["status"] = "error"
            state["error"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"success": True, "job": job}


def smart_chain_suggest_meta(template):
    """抓包草稿 → LLM 生成触发元信息（intent/触发词/示例问/禁用场景），
    让 AI 选模板时知道「什么时候用这个技能」。"""
    if not isinstance(template, dict):
        return {"success": False, "message": "template 必须是 JSON 对象"}
    brief = {
        "name": template.get("name"),
        "description": template.get("description"),
        "steps": [{
            "id": s.get("id"),
            "description": s.get("description"),
            "url": (s.get("page_interact") or {}).get("navigate_url") or s.get("url_template"),
            "outputs": list((s.get("output_extract") or {}).keys())[:10],
        } for s in (template.get("steps") or [])],
        "final_output": list((template.get("final_output") or {}).keys())[:20],
        "input": list((template.get("input") or {}).keys()),
    }
    prompt = ("你是业务技能注册管理员。根据下面的查询模板草稿，生成让它被 AI 正确选用的注册信息：\n"
              "1. intent_summary：一句话说清什么场景用这个技能查什么（含业务系统名与数据类型）\n"
              "2. trigger_keywords：6~10 个触发关键词（业务术语/页面名/字段名/同义词）\n"
              "3. sample_questions：3 个典型用户问法\n"
              "4. do_not_use_when：2 个不应使用本模板的场景\n"
              "严格只返回 JSON：{\"intent_summary\",\"trigger_keywords\",\"sample_questions\",\"do_not_use_when\"}\n"
              "模板草稿：" + json.dumps(brief, ensure_ascii=False))
    r = direct_chat([{"role": "user", "content": prompt}])
    if not r.get("success"):
        return r
    import re as _re
    text = r["reply"].strip()
    m = _re.search(r"\{[\s\S]*\}", text)
    try:
        meta = json.loads(m.group(0) if m else text)
    except Exception:
        return {"success": False, "message": "模型返回非 JSON，请重试",
                "raw": text[:300]}
    return {"success": True, "meta": meta}


def smart_chain_detect_status(job):
    st = DETECT_JOBS.get(job)
    if not st:
        return {"success": False, "message": "job 不存在"}
    return {"success": True, "status": st["status"], "error": st["error"],
            "draft": st["draft"], "logs": st["logs"][-200:]}


CHAIN_RUN_JOBS = {}


def smart_chain_run_start(payload):
    """原子能力直连调试：按模板名跑 run_chain.py（异步 job + 轮询）。"""
    import uuid
    import tempfile
    name = (payload.get("name") or "").strip()
    params = payload.get("input") or {}
    try:
        idx, key = _smart_chain_index_load()
    except Exception as e:
        return {"success": False, "message": str(e)}
    hit = next((t for t in idx.get(key, []) if t.get("name") == name), None)
    if not hit:
        return {"success": False, "message": f"模板不存在: {name}"}
    root = os.path.dirname(os.path.dirname(SMART_CHAIN_INDEX))
    chain_path = os.path.join(root, hit.get("template_path", ""))
    job = uuid.uuid4().hex[:8]
    state = {"status": "running", "result": None, "error": ""}
    CHAIN_RUN_JOBS[job] = state

    def _run():
        out_path = os.path.join(tempfile.mkdtemp(prefix="sw_cr_"), "out.json")
        inp = ",".join(f"{k}={v}" for k, v in params.items())
        cmd = [sys.executable, os.path.join(root, "assets", "run_chain.py"),
               "--chain", chain_path, "--input", inp, "--out", out_path]
        try:
            p = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            state["status"] = "error"
            state["error"] = "执行超时(180s)"
            return
        if os.path.exists(out_path):
            try:
                with open(out_path, encoding="utf-8") as f:
                    state["result"] = json.load(f)
                state["status"] = "done"
            except Exception as e:
                state["status"] = "error"
                state["error"] = f"输出解析失败: {e}"
            return
        state["status"] = "error"
        state["error"] = ("执行无产出。" +
                          ((p.stdout or "")[-400:] + (p.stderr or "")[-200:]).strip())

    threading.Thread(target=_run, daemon=True).start()
    return {"success": True, "job": job}


def smart_chain_run_status(job):
    st = CHAIN_RUN_JOBS.get(job)
    if not st:
        return {"success": False, "message": "job 不存在"}
    return {"success": True, "status": st["status"],
            "result": st["result"], "error": st["error"]}


def smart_chain_delete_template(name):
    """删除用户自建（custom）模板；内置模板受保护。"""
    idx, key = _smart_chain_index_load()
    items = idx.get(key, [])
    hit = next((t for t in items if t.get("name") == name), None)
    if not hit:
        return {"success": False, "message": f"模板不存在: {name}"}
    if not hit.get("custom"):
        return {"success": False, "message": "内置模板不可删除，仅可删除自建技能"}
    root = os.path.dirname(os.path.dirname(SMART_CHAIN_INDEX))
    try:
        os.remove(os.path.join(root, hit.get("template_path", "")))
    except OSError:
        pass
    idx[key] = [t for t in items if t.get("name") != name]
    with open(SMART_CHAIN_INDEX, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)
    return {"success": True, "name": name}


# ================= 业办工作流 Skill（自然语言 SOP + 受约束 ReAct 编排） =================
WORKFLOWS_FILE = os.path.join(os.path.dirname(SMART_CHAIN_INDEX), "workflows.json")
WORKFLOW_RUNS = {}
WORKFLOW_SESSIONS = {}  # session_id -> 粘滞工作流 id（多轮补参对话续接路由）


def _workflows_load():
    if not os.path.exists(WORKFLOWS_FILE):
        return {"workflows": []}
    try:
        with open(WORKFLOWS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"workflows": []}


def _workflows_save(data):
    with open(WORKFLOWS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def workflows_list():
    return {"success": True, "workflows": _workflows_load().get("workflows", [])}


def workflow_save(wf):
    """upsert 工作流：自然语言 SOP + 原子能力白名单 + 步数上限。"""
    import uuid
    if not isinstance(wf, dict) or not (wf.get("name") or "").strip():
        return {"success": False, "message": "工作流名称必填"}
    if not (wf.get("sop") or "").strip():
        return {"success": False, "message": "SOP 描述必填（自然语言编排逻辑）"}
    data = _workflows_load()
    wfs = data.get("workflows", [])
    wf = dict(wf)
    wf["id"] = (wf.get("id") or "").strip() or ("wf-" + uuid.uuid4().hex[:8])
    try:
        wf["max_steps"] = max(1, min(12, int(wf.get("max_steps") or 6)))
    except (TypeError, ValueError):
        wf["max_steps"] = 6
    wf["skills"] = wf.get("skills") or []
    wf["updated_at"] = int(time.time())
    for i, old in enumerate(wfs):
        if old.get("id") == wf["id"]:
            wf["created_at"] = old.get("created_at", wf["updated_at"])
            wfs[i] = wf
            break
    else:
        wf["created_at"] = wf["updated_at"]
        wfs.insert(0, wf)
    data["workflows"] = wfs
    _workflows_save(data)
    return {"success": True, "id": wf["id"]}


def workflow_delete(wid):
    data = _workflows_load()
    data["workflows"] = [w for w in data.get("workflows", []) if w.get("id") != wid]
    _workflows_save(data)
    return {"success": True}


def _wf_skill_catalog(names):
    """白名单技能目录：从 INDEX 取 name/intent/必填入参/chain 文件路径。"""
    try:
        idx, key = _smart_chain_index_load()
    except Exception as e:
        return [], str(e)
    items = {t.get("name"): t for t in idx.get(key, [])}
    root = os.path.dirname(os.path.dirname(SMART_CHAIN_INDEX))
    cat = []
    for n in names or []:
        t = items.get(n)
        if not t:
            continue
        cat.append({
            "name": n,
            "intent": t.get("intent", ""),
            "input_required": [(p.get("name") or str(p)) if isinstance(p, dict) else str(p)
                               for p in t.get("input_required", [])],
            "chain_path": os.path.join(root, t.get("template_path", "")),
        })
    return cat, None


def _direct_chat_retry(prompt, tries=2):
    """直连模型：失败或空回复自动重试（抵模型瞬时抖动，如「未返回内容」）。"""
    last = {"success": False, "message": "模型未返回内容"}
    for _ in range(tries):
        r = direct_chat([{"role": "user", "content": prompt}])
        if r.get("success") and (r.get("reply") or "").strip():
            return r
        last = r if not r.get("success") else {"success": False, "message": "模型未返回内容"}
    return last


def workflow_suggest_sop(payload):
    """场景描述 + 白名单技能 → AI 起草自然语言 SOP。"""
    desc = (payload.get("description") or "").strip()
    if not desc:
        return {"success": False, "message": "场景描述必填"}
    cat, err = _wf_skill_catalog(payload.get("skills") or [])
    if err:
        return {"success": False, "message": err}
    skills_brief = [{"name": c["name"], "intent": c["intent"],
                     "input": c["input_required"]} for c in cat]
    prompt = ("你是业务工作流设计者。为下面的业务场景写一段可执行的自然语言 SOP。\n"
              "SOP 必须采用 Agent SOP 规范（strands-agents/agent-sop）的章节结构：\n"
              "## Overview：目标 + 适用场景\n"
              "## Parameters：snake_case 参数名 + (required)/(optional)，并约束开始前一次性确认必填参数\n"
              "## Steps：编号步骤，每步指明调用的白名单能力准确名称与入参取值来源（用户输入或前序输出字段），"
              "并带 Constraints：用 MUST/SHOULD/MUST NOT 表述；条件步用 If …你 MUST …Otherwise …；"
              "负向约束必须带原因（MUST NOT X 因为 Y）\n"
              "## 终止与升级：何时 MUST finish；能力执行失败时 MUST NOT 同参重试，注明失败项后 finish\n"
              "## 输出契约：结论 MUST 包含的要素\n"
              "## Troubleshooting：常见异常与处理\n"
              "白名单原子能力：" + json.dumps(skills_brief, ensure_ascii=False) + "\n"
              "只返回 SOP 正文。\n"
              "业务场景：" + desc)
    r = _direct_chat_retry(prompt)
    if not r.get("success"):
        return r
    return {"success": True, "sop": r["reply"].strip()}


def workflow_suggest_meta(wf):
    """工作流草稿 → AI 生成触发元信息（与原子能力同一注册规范）。"""
    brief = {"name": wf.get("name"), "sop": (wf.get("sop") or "")[:800],
             "skills": wf.get("skills") or []}
    prompt = ("你是业务技能注册管理员。根据下面的工作流草稿，生成让 AI 正确选用的注册信息：\n"
              "1. intent_summary：一句话说清这个工作流串联处理什么端到端业务场景\n"
              "2. trigger_keywords：6~10 个触发关键词\n"
              "3. sample_questions：3 个典型用户问法\n"
              "4. do_not_use_when：2 个不应使用本工作流的场景（如单一原子能力即可满足时）\n"
              "严格只返回 JSON：{\"intent_summary\",\"trigger_keywords\",\"sample_questions\",\"do_not_use_when\"}\n"
              "工作流草稿：" + json.dumps(brief, ensure_ascii=False))
    r = _direct_chat_retry(prompt)
    if not r.get("success"):
        return r
    m = re.search(r"\{[\s\S]*\}", r["reply"].strip())
    try:
        meta = json.loads(m.group(0) if m else r["reply"])
    except Exception:
        return {"success": False, "message": "模型返回非 JSON，请重试",
                "raw": r["reply"][:300]}
    return {"success": True, "meta": meta}


def _wf_decide(wf, catalog, user_input, trace):
    """受约束 ReAct 决策：LLM 只能在白名单内选下一步，或 finish 出结论。"""
    skills_brief = [{"name": c["name"], "intent": c["intent"],
                     "input_required": c["input_required"]} for c in catalog]
    trace_brief = [{"step": i + 1, "thought": t.get("thought", ""),
                    "skill": t.get("skill"), "params": t.get("params"),
                    "result": (t.get("result_text") or t.get("error") or "")[:900]}
                   for i, t in enumerate(trace)]
    prompt = ("你是业务工作流执行引擎。按下面 SOP，结合已执行步骤与结果，决定下一步动作。\n"
              "约束：\n"
              "1. 只能调用白名单中的原子能力，params 的 key 必须与其 input_required 完全一致\n"
              "2. 参数值只能来自用户输入或已执行步骤的输出，不得编造业务数据\n"
              "3. SOP 目标已达成或判定无需继续时，输出 finish 并给出最终结论\n"
              "SOP：" + (wf.get("sop") or "") + "\n"
              "用户输入：" + json.dumps(user_input, ensure_ascii=False) + "\n"
              "白名单能力：" + json.dumps(skills_brief, ensure_ascii=False) + "\n"
              "已执行步骤：" + json.dumps(trace_brief, ensure_ascii=False) + "\n"
              "严格只返回 JSON，二选一：\n"
              "{\"thought\": \"推理\", \"skill\": \"能力名\", \"params\": {}}\n"
              "或 {\"thought\": \"推理\", \"finish\": \"最终结论\"}")
    r = _direct_chat_retry(prompt)
    if not r.get("success"):
        return None, r.get("message") or "LLM 调用失败"
    m = re.search(r"\{[\s\S]*\}", r["reply"].strip())
    try:
        d = json.loads(m.group(0) if m else r["reply"])
    except Exception:
        return None, "模型返回非 JSON 决策"
    return d, None


def _wf_result_text(result):
    """run_chain 输出 → 可读摘要（供 LLM 上下文与前端展示）。"""
    if not isinstance(result, dict):
        return str(result)[:1500]
    for k in ("final_output", "output", "result"):
        if isinstance(result.get(k), (dict, list)):
            return json.dumps(result[k], ensure_ascii=False)[:1500]
    return json.dumps(result, ensure_ascii=False)[:1500]


def _wf_param_ok(req_name, params):
    """必填参数满足判定：兼容「A 或 B 或 C（五选一）」组合名，任一别名有值即满足。"""
    alts = [a.split("(")[0].split("（")[0].strip()
            for a in re.split(r"\s*或\s*|[、,，/]", req_name or "")]
    alts = [a for a in alts if a]
    if not alts:
        alts = [(req_name or "").strip()]
    return any(str(params.get(a) or "").strip() for a in alts)


def _wf_run_atomic(entry, params):
    """调原子能力执行引擎 run_chain.py（CDP 取登录态执行）。"""
    import tempfile
    out_path = os.path.join(tempfile.mkdtemp(prefix="sw_wf_"), "out.json")
    inp = ",".join(f"{k}={v}" for k, v in (params or {}).items())
    root = os.path.dirname(os.path.dirname(SMART_CHAIN_INDEX))
    cmd = [sys.executable, os.path.join(root, "assets", "run_chain.py"),
           "--chain", entry["chain_path"], "--input", inp, "--out", out_path]
    try:
        p = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return {"success": False, "message": "原子能力执行超时(180s)"}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                return {"success": True, "result": json.load(f)}
        except Exception as e:
            return {"success": False, "message": f"输出解析失败: {e}"}
    tail = ((p.stdout or "")[-400:] + (p.stderr or "")[-200:]).strip()
    return {"success": False, "message": "执行无产出。" + tail}


def workflow_run_start(payload):
    """启动工作流执行（后台线程），返回 run_id 供轮询 trace。"""
    import uuid
    wid = (payload.get("workflow_id") or "").strip()
    wf = next((w for w in _workflows_load().get("workflows", [])
               if w.get("id") == wid), None)
    if not wf:
        return {"success": False, "message": "工作流不存在"}
    user_input = payload.get("input") or {}
    run_id = uuid.uuid4().hex[:8]
    run = {"status": "running", "trace": [], "conclusion": "", "error": ""}
    WORKFLOW_RUNS[run_id] = run

    def _loop():
        out = _workflow_run_sync(wf, user_input)
        run.update(out)
        run["status"] = "error" if out.get("error") else "done"

    threading.Thread(target=_loop, daemon=True).start()
    return {"success": True, "run_id": run_id}


def _workflow_run_sync(wf, user_input):
    """受约束 ReAct 同步执行，返回 {trace, conclusion, error}。"""
    out = {"trace": [], "conclusion": "", "error": ""}
    try:
        cat, err = _wf_skill_catalog(wf.get("skills") or [])
        if err or not cat:
            out["error"] = err or "白名单能力在 INDEX 中不存在，请检查技能选择"
            return out
        allowed = {c["name"]: c for c in cat}
        for _ in range(wf.get("max_steps", 6)):
            d, derr = _wf_decide(wf, cat, user_input, out["trace"])
            if derr:
                out["error"] = derr
                return out
            if d.get("finish"):
                out["conclusion"] = str(d["finish"])
                return out
            skill = str(d.get("skill") or "").strip()
            params = d.get("params") or {}
            if skill not in allowed:
                out["trace"].append({"thought": d.get("thought", ""), "skill": skill,
                                     "params": params,
                                     "error": f"不在白名单（可选：{'/'.join(allowed)}），已拒绝"})
                continue
            entry = allowed[skill]
            missing = [n for n in entry["input_required"]
                       if not _wf_param_ok(n, params)]
            if missing:
                out["trace"].append({"thought": d.get("thought", ""), "skill": skill,
                                     "params": params,
                                     "error": f"缺必填参数: {','.join(missing)}，已打回"})
                continue
            ar = _wf_run_atomic(entry, params)
            step = {"thought": d.get("thought", ""), "skill": skill, "params": params}
            if ar.get("success"):
                step["result"] = ar["result"]
                step["result_text"] = _wf_result_text(ar["result"])
            else:
                step["error"] = ar.get("message")
            out["trace"].append(step)
        out["conclusion"] = (out["conclusion"]
                             or "已达最大步数未产出结论，请查看执行轨迹")
    except Exception as e:
        out["error"] = str(e)
    return out


def _wf_match(message):
    """对话路由：按名称/触发词/意图词元重叠匹配工作流（≥2 词命中）。"""
    mt = _tok_set(message)
    if not mt:
        return None
    best, best_sc = None, 0
    for w in _workflows_load().get("workflows", []):
        toks = (_tok_set(w.get("name") or "")
                | _tok_set(" ".join(w.get("trigger_keywords") or []))
                | _tok_set(w.get("intent") or ""))
        sc = len(toks & mt)
        if sc > best_sc:
            best_sc, best = sc, w
    return best if best_sc >= 2 else None


def workflow_run_status(run_id):
    run = WORKFLOW_RUNS.get(run_id)
    if not run:
        return {"success": False, "message": "执行记录不存在"}
    return {"success": True, "status": run["status"], "trace": run["trace"],
            "conclusion": run["conclusion"], "error": run["error"]}


def _kb_index():
    p = os.path.join(KB_OUT_DIR, "index.json")
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _kb_overview(doc):
    """概述提取：兼容 builtin(## 概述 段) 与 llmwiki(首个非标题段)。"""
    if "## 概述" in doc:
        return doc.split("## 概述")[1].split("###")[0].strip()
    for para in doc.splitlines():
        p = para.strip()
        if p and not p.startswith("#") and not p.startswith("-"):
            return p[:300]
    return ""


def kb_topics():
    idx = _kb_index()
    if not idx:
        return {"success": False,
                "message": "未找到编译知识库（先运行 kb_compiler.py compile）"}
    topics = [{"name": name,
               "overview": _kb_overview(t["doc"]),
               "slice_count": len(t["slice_ids"])}
              for name, t in idx["topics"].items()]
    return {"success": True, "built_at": idx.get("built_at"),
            "engine": idx.get("engine", "builtin"),
            "conflict_total": len(idx.get("conflicts") or []),
            "slice_total": len(idx["slices"]), "topics": topics}


def kb_topic(name):
    idx = _kb_index()
    t = (idx or {}).get("topics", {}).get(name)
    if not t:
        return {"success": False, "message": f"主题不存在: {name}"}
    return {"success": True, "name": name, "doc": t["doc"],
            "slice_ids": t["slice_ids"]}


def kb_search(q, topk=3):
    """复用 kb_compiler 的 RecallIndex（别名层 + 主题扩展）。"""
    if not q:
        return {"success": False, "message": "缺少 q 参数"}
    try:
        sys.path.insert(0, os.path.dirname(KB_OUT_DIR))
        import kb_compiler as kbc  # noqa
        ri = kbc.RecallIndex(KB_OUT_DIR)
        return {"success": True, "hits": ri.search(q, topk)}
    except Exception as e:
        return {"success": False, "message": f"召回失败: {e}"}


# ------------------------------------------------------------
# 发布到文档平台（语雀）：wiki Markdown 即交换格式，
# sync.json 记录 主题->doc_id 映射，重复发布同一主题 = 更新
# ------------------------------------------------------------

# 知识库写入规则（发布时强制执行）
KB_PUBLISH_RULES = [
    "一主题一文章：每个编译主题对应一篇独立的语雀文档，禁止合并多主题",
    "标题即主题名：文档标题与主题名完全一致，便于双向映射与检索",
    "全文写入：文档正文 = 编译产出的完整 Markdown，不截断不摘要",
    "同名去重：发布前扫描仓库已有文档，同标题文档就地更新，不产生重复文章",
    "映射可追溯：主题->doc_id 映射持久化在 kb_out/sync.json，重复发布=原地更新",
]

def _kb_sync_load():
    p = os.path.join(KB_OUT_DIR, "sync.json")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _kb_sync_save(data):
    with open(os.path.join(KB_OUT_DIR, "sync.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def kb_sync_status():
    sync = _kb_sync_load()
    yq = sync.get("yuque", {})
    return {"success": True, "yuque": yq.get("docs", {}),
            "namespace": yq.get("namespace", ""),
            "config": yq.get("config", {}),
            "rules": KB_PUBLISH_RULES}


def _yuque_api(method, url, token, payload=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("X-Auth-Token", token)
    req.add_header("User-Agent", "kb-compiler-sync")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(payload).encode("utf-8") if payload else None
    with urllib.request.urlopen(req, data, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def kb_publish_yuque(token, namespace, topic=None,
                     api_base="https://www.yuque.com"):
    """把编译好的主题文档推到语雀：无映射则新建，有映射则更新。
    企业内网部署时把 api_base 传为 local_settings.YUQUE_INTERNAL_API_BASE。"""
    idx = _kb_index()
    if not idx:
        return {"success": False, "message": "未找到编译知识库"}
    if not token or not namespace:
        return {"success": False, "message": "需要语雀 token 和知识库 namespace"}
    ns = namespace.strip().strip("/")
    api_base = (api_base or "https://www.yuque.com").rstrip("/")
    # 文档 web 域名：企业内网 API 对应内网 web 域名（见 local_settings）
    web_base = (YUQUE_INTERNAL_WEB_BASE if YUQUE_INTERNAL_WEB_BASE
                and YUQUE_INTERNAL_API_BASE
                and YUQUE_INTERNAL_API_BASE in api_base
                else api_base)
    base = api_base + "/api/v2/repos/" + ns
    try:
        _yuque_api("GET", base, token)
    except urllib.error.HTTPError as e:
        return {"success": False,
                "message": f"语雀知识库校验失败({e.code})：检查 token 与 namespace"}
    except Exception as e:
        return {"success": False, "message": f"语雀请求失败: {e}"}

    sync = _kb_sync_load()
    yq = sync.setdefault("yuque", {"namespace": ns, "docs": {}})
    # 发布配置落盘，工作台后续发布免重复填写
    yq["config"] = {"token": token, "api_base": api_base, "namespace": ns}
    # 写入规则·同名去重：扫描仓库已有文档，建立 标题->id 映射，
    # 避免 sync.json 映射缺失时创建重复文章
    remote_by_title = {}
    try:
        r = _yuque_api("GET", base + "/docs", token)
        for d in r.get("data", []):
            remote_by_title[d.get("title")] = d.get("id")
    except Exception:
        pass  # 列表拉取失败不阻塞发布，退化为按映射发布
    targets = [topic] if topic else list(idx["topics"].keys())
    results = []
    for name in targets:
        t = idx["topics"].get(name)
        if not t:
            results.append({"topic": name, "ok": False, "error": "主题不存在"})
            continue
        doc_id = yq["docs"].get(name)
        action_hint = "update"
        if not doc_id and name in remote_by_title:
            # 仓库已有同名文档（映射缺失/手工创建）→ 绑定并更新，不新建
            doc_id = remote_by_title[name]
            action_hint = "bind"
        payload = {"title": name, "body": t["doc"], "format": "markdown"}
        try:
            if doc_id:
                r = _yuque_api("PUT", f"{base}/docs/{doc_id}", token, payload)
            else:
                payload["public"] = 0
                r = _yuque_api("POST", base + "/docs", token, payload)
            d = r.get("data", {})
            yq["docs"][name] = d.get("id")
            yq.setdefault("updated_at", {})[name] = time.time()
            results.append({
                "topic": name, "ok": True, "doc_id": d.get("id"),
                "action": ("create" if not action_hint or action_hint == ""
                           else ("update" if action_hint == "update" else action_hint))
                if doc_id else "create",
                "url": f"{web_base}/{ns}/{d.get('slug')}"})
        except Exception as e:
            results.append({"topic": name, "ok": False, "error": str(e)})
    _kb_sync_save(sync)
    ok = sum(1 for r in results if r["ok"])
    return {"success": ok > 0, "published": ok, "total": len(results),
            "results": results}


def kb_check_conflict(token, namespace, api_base="https://www.yuque.com"):
    """检查语雀端是否有发布后的人工编辑（未拉回就重发布会被覆盖）。"""
    sync = _kb_sync_load()
    yq = sync.get("yuque", {})
    cfg = yq.get("config", {})
    token = token or cfg.get("token") or ""
    api_base = (api_base if api_base != "https://www.yuque.com"
                else cfg.get("api_base") or api_base)
    ns = (namespace or yq.get("namespace", "")).strip().strip("/")
    if not token or not ns:
        return {"success": False, "message": "需要 token 和 namespace"}
    base = (api_base or "https://www.yuque.com").rstrip("/")
    stale = []
    try:
        for name, doc_id in yq.get("docs", {}).items():
            r = _yuque_api("GET", f"{base}/api/v2/repos/{ns}/docs/{doc_id}",
                           token)
            d = r.get("data", {})
            upd = d.get("content_updated_at") or d.get("updated_at") or ""
            if not upd:
                continue
            remote_ts = datetime.fromisoformat(upd.replace("Z", "+00:00")).timestamp()
            pub_ts = yq.get("updated_at", {}).get(name) or 0
            if remote_ts > pub_ts + 5:  # 5s 容差
                stale.append({"topic": name, "doc_id": doc_id,
                              "remote_updated_at": upd})
    except Exception as e:
        return {"success": False, "message": f"检查失败: {e}"}
    return {"success": True, "stale": stale}


def kb_pull_yuque(token, namespace, api_base="https://www.yuque.com"):
    """拉回语雀上人工编辑过的文档 → wiki/*.md + index.json 主题层热更新。
    别名层（相似问召回）保持不动。"""
    idx = _kb_index()
    if not idx:
        return {"success": False, "message": "未找到编译知识库"}
    cfg = _kb_sync_load().get("yuque", {}).get("config", {})
    token = token or cfg.get("token") or ""
    api_base = (api_base if api_base != "https://www.yuque.com"
                else cfg.get("api_base") or api_base)
    chk = kb_check_conflict(token, namespace, api_base)
    if not chk.get("success"):
        return chk
    stale = {s["topic"]: s["doc_id"] for s in chk.get("stale", [])}
    if not stale:
        return {"success": True, "pulled": 0, "results": [],
                "message": "语雀端没有比本地更新的文档"}
    sync = _kb_sync_load()
    yq = sync.setdefault("yuque", {})
    ns = (namespace or yq.get("namespace", "")).strip().strip("/")
    base = (api_base or "https://www.yuque.com").rstrip("/")
    wiki_dir = os.path.join(KB_OUT_DIR, "wiki")
    results = []
    for name, doc_id in stale.items():
        try:
            r = _yuque_api("GET",
                           f"{base}/api/v2/repos/{ns}/docs/{doc_id}?raw=1",
                           token)
            d = r.get("data", {})
            body = d.get("body") or ""
            if not body:
                results.append({"topic": name, "ok": False,
                                "error": "语雀返回空内容"})
                continue
            # 写回 wiki 与索引主题层
            safe = re.sub(r"[^\w\u4e00-\u9fff-]", "_", name)
            with open(os.path.join(wiki_dir, f"{safe}.md"), "w",
                      encoding="utf-8") as f:
                f.write(body)
            if name in idx.get("topics", {}):
                idx["topics"][name]["doc"] = body
            # 拉回后刷新同步时间戳，避免冲突检查重复误报
            yq.setdefault("updated_at", {})[name] = time.time()
            results.append({"topic": name, "ok": True, "chars": len(body)})
        except Exception as e:
            results.append({"topic": name, "ok": False, "error": str(e)})
    if any(r["ok"] for r in results):
        # 重建主题层检索文档，别名层不动
        idx["topic_docs"] = [
            (name, name + " " + re.sub(r"[#>`\n]+", " ", t["doc"])[:2000])
            for name, t in idx.get("topics", {}).items()]
        shutil.copy(os.path.join(KB_OUT_DIR, "index.json"),
                    os.path.join(KB_OUT_DIR, "index.pull-backup.json"))
        with open(os.path.join(KB_OUT_DIR, "index.json"), "w",
                  encoding="utf-8") as f:
            json.dump(idx, f, ensure_ascii=False)
        _kb_sync_save(sync)
    ok = sum(1 for r in results if r["ok"])
    return {"success": ok > 0, "pulled": ok, "results": results}


def kb_publish(body):
    target = body.get("target") or "yuque"
    if target == "yuque":
        cfg = _kb_sync_load().get("yuque", {}).get("config", {})
        return kb_publish_yuque(
            body.get("token") or cfg.get("token") or "",
            body.get("namespace") or cfg.get("namespace") or "",
            body.get("topic"),
            body.get("api_base") or cfg.get("api_base") or "https://www.yuque.com")
    return {"success": False, "message": f"暂不支持的目标平台: {target}"}


# ============================================================
# 知识更新流水线（上传源文件 → 重编译 → diff → 发布）
# ============================================================

KB_COMPILER_DIR = os.environ.get(
    "KB_COMPILER_DIR", os.path.dirname(KB_OUT_DIR))
KB_SRC_DIR = os.path.join(KB_COMPILER_DIR, "sources")
KB_BUILD_STATUS = os.path.join(KB_COMPILER_DIR, "build_status.json")
KB_BUILD_LOG = os.path.join(KB_COMPILER_DIR, "build.log")
_kb_build_proc = None


def _kb_write_status(status, detail=""):
    with open(KB_BUILD_STATUS, "w", encoding="utf-8") as f:
        json.dump({"status": status, "detail": detail,
                   "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")},
                  f, ensure_ascii=False)


def kb_list_sources():
    os.makedirs(KB_SRC_DIR, exist_ok=True)
    files = []
    for fn in sorted(os.listdir(KB_SRC_DIR)):
        if fn.endswith(".xlsx"):
            p = os.path.join(KB_SRC_DIR, fn)
            files.append({"name": fn, "size": os.path.getsize(p),
                          "mtime": time.strftime(
                              "%Y-%m-%d %H:%M",
                              time.localtime(os.path.getmtime(p)))})
    return {"success": True, "files": files, "dir": KB_SRC_DIR}


def kb_upload_source(name, data):
    """前端以二进制 POST，文件名走 X-Filename 头，避免 multipart 解析。
    保存后与语雀知识库（基准）对比查重，结果记入维护待办。"""
    safe = os.path.basename(name or "")
    if not safe.endswith(".xlsx"):
        return {"success": False, "message": "仅支持 .xlsx 文件"}
    if len(data) < 1024:
        return {"success": False, "message": "文件过小，可能损坏"}
    os.makedirs(KB_SRC_DIR, exist_ok=True)
    with open(os.path.join(KB_SRC_DIR, safe), "wb") as f:
        f.write(data)
    try:
        compare = kb_upload_compare_yuque(safe)
    except Exception as e:
        compare = {"compared": False, "message": f"对比失败: {e}"}
    return {"success": True, "name": safe, "size": len(data),
            "yuque_compare": compare}


def kb_upload_compare_yuque(xlsx_name):
    """上传新知识 → 与语雀知识库对比：检出疑似重复，新增入维护待办供裁决。"""
    path = os.path.join(KB_SRC_DIR, xlsx_name)
    if not os.path.exists(path):
        return {"compared": False, "message": "文件不存在"}
    docs = _yuque_fetch_docs(with_body=True, ttl=0)
    if not docs:
        return {"compared": False,
                "message": "语雀知识库未配置或不可达，跳过对比"}
    sys.path.insert(0, os.path.dirname(KB_OUT_DIR))
    import kb_compiler as kbc  # noqa
    slices = kbc.load_slices(path)
    dup, new_cnt = [], 0
    for s in slices:
        st = set(kbc.tokenize(s["title"]))
        best, best_ov = None, 0.0
        for d in docs:
            dt = set(kbc.tokenize(d["title"]))
            if not st or not dt:
                continue
            ov = len(st & dt) / min(len(st), len(dt))
            if ov > best_ov:
                best, best_ov = d, ov
        if best and best_ov >= 0.5:
            dup.append({"upload": s["title"], "yuque": best["title"],
                        "overlap": round(best_ov, 2)})
        else:
            new_cnt += 1
    store = _kb_maintenance_load()
    tid = f"upload-{int(time.time())}"
    desc = (f"上传 {xlsx_name}：共 {len(slices)} 条，"
            f"疑似与语雀重复 {len(dup)} 条，新增 {new_cnt} 条待编译发布")
    store["tasks"].append({
        "id": tid, "type": "upload_review", "title": desc,
        "detail": {"file": xlsx_name, "total": len(slices),
                   "duplicates": dup[:20], "new_count": new_cnt,
                   "desc": desc},
        "status": "pending", "resolution": "", "resolved_at": 0})
    _kb_maintenance_save(store)
    log(f"upload compare: {xlsx_name} total={len(slices)} dup={len(dup)}")
    return {"compared": True, "total": len(slices), "duplicates": dup[:20],
            "new_count": new_cnt, "task_id": tid}


def _kb_diff(old, new):
    """对比新旧索引：主题与切片的增删改。"""
    d = {"old_built_at": old.get("built_at"), "new_built_at": new.get("built_at"),
         "slice_added": [], "slice_removed": [], "slice_changed": [],
         "topic_added": [], "topic_removed": []}
    old_s, new_s = old.get("slices", {}), new.get("slices", {})
    for sid in new_s:
        if sid not in old_s:
            d["slice_added"].append(sid)
        elif (old_s[sid].get("content") != new_s[sid].get("content")
              or old_s[sid].get("title") != new_s[sid].get("title")):
            d["slice_changed"].append(sid)
    for sid in old_s:
        if sid not in new_s:
            d["slice_removed"].append(sid)
    for name in new.get("topics", {}):
        if name not in old.get("topics", {}):
            d["topic_added"].append(name)
    for name in old.get("topics", {}):
        if name not in new.get("topics", {}):
            d["topic_removed"].append(name)
    d["old_slice_total"] = len(old_s)
    d["new_slice_total"] = len(new_s)
    return d


def kb_build_status():
    if os.path.exists(KB_BUILD_STATUS):
        try:
            with open(KB_BUILD_STATUS, encoding="utf-8") as f:
                st = json.load(f)
        except Exception:
            st = {"status": "unknown"}
    else:
        st = {"status": "idle", "detail": "尚未编译过"}
    log_tail = ""
    if os.path.exists(KB_BUILD_LOG):
        with open(KB_BUILD_LOG, encoding="utf-8") as f:
            log_tail = "".join(f.readlines()[-30:])
    # diff：index.prev.json 存在时对比当前 index.json
    diff = None
    prev_p = os.path.join(KB_OUT_DIR, "index.prev.json")
    cur_p = os.path.join(KB_OUT_DIR, "index.json")
    if os.path.exists(prev_p) and os.path.exists(cur_p):
        try:
            diff = _kb_diff(json.load(open(prev_p, encoding="utf-8")),
                            json.load(open(cur_p, encoding="utf-8")))
        except Exception:
            diff = None
    return {"success": True, **st, "log_tail": log_tail, "diff": diff}


# ------------------------------------------------------------
# 知识维护待办（冲突裁决 / 未覆盖问题）
# 存储: kb_out/maintenance.json；冲突源: conflicts.md 台账（引擎无关）
# ------------------------------------------------------------
def _kb_maintenance_path():
    return os.path.join(KB_OUT_DIR, "maintenance.json")


def _kb_maintenance_load():
    p = _kb_maintenance_path()
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"tasks": []}


def _kb_maintenance_save(store):
    with open(_kb_maintenance_path(), "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)


def _raw_note_body(path):
    """读 raw/notes 切片原文（跳过 frontmatter），供冲突 diff 展示完整原文。"""
    p = os.path.join(KB_OUT_DIR, (path or "").strip())
    if not os.path.exists(p):
        return ""
    text = open(p, encoding="utf-8").read()
    if text.startswith("---"):
        end = text.find("---", 3)
        if end > 0:
            text = text[end + 3:]
    return text.strip()


def _parse_conflicts_md():
    """解析 conflicts.md 台账为结构化冲突列表（含两侧切片完整原文）。"""
    p = os.path.join(KB_OUT_DIR, "conflicts.md")
    if not os.path.exists(p):
        return []
    text = open(p, encoding="utf-8").read()
    out = []
    for block in re.split(r"\n## \[", text)[1:]:
        head, _, body = block.partition("]")
        cid = head.strip()
        title = body.split("\n", 1)[0].strip()
        fields = {}
        for line in body.split("\n"):
            line = line.strip()
            if line.startswith("- "):
                k, _, v = line[2:].partition(":")
                fields[k.strip()] = v.strip()
        src_a = fields.get("来源A", "")
        src_b = fields.get("来源B", "")
        # 来源可能多个（逗号分隔），原文全部带上
        full_a = "\n\n---\n\n".join(
            _raw_note_body(s) for s in [x.strip() for x in src_a.split(",") if x.strip()]
        ).strip()
        full_b = "\n\n---\n\n".join(
            _raw_note_body(s) for s in [x.strip() for x in src_b.split(",") if x.strip()]
        ).strip()
        out.append({
            "id": cid, "title": title,
            "desc": fields.get("冲突描述", ""),
            "say_a": fields.get("说法A(旧)", "") or fields.get("说法A", ""),
            "src_a": src_a, "full_a": full_a,
            "say_b": fields.get("说法B(新)", "") or fields.get("说法B", ""),
            "src_b": src_b, "full_b": full_b,
            "suggestion": fields.get("AI建议", ""),
            "ledger_status": fields.get("状态", ""),
        })
    return out


def kb_maintenance_list():
    """待办列表：conflicts.md 台账同步进 maintenance.json（已裁决的不覆盖）。"""
    store = _kb_maintenance_load()
    existing = {t["id"]: t for t in store["tasks"]}
    for c in _parse_conflicts_md():
        detail = c
        if c["id"] not in existing:
            existing[c["id"]] = {
                "id": c["id"], "type": "conflict", "title": c["title"],
                "detail": c, "status": "pending",
                "resolution": "", "resolved_at": 0,
            }
        else:
            # 刷新详情（补上新增字段如完整原文），保留裁决状态
            existing[c["id"]]["detail"] = detail
    store["tasks"] = list(existing.values())
    _kb_maintenance_save(store)
    tasks = sorted(store["tasks"],
                   key=lambda t: (t["status"] != "pending", t["id"]))
    pending = sum(1 for t in tasks if t["status"] == "pending")
    meta = store.get("meta") or {}
    last_scan = meta.get("last_scan") or 0
    next_scan = last_scan + meta.get("interval_h", KB_SCAN_INTERVAL_H) * 3600 * 1000 if last_scan else 0
    return {"success": True, "tasks": tasks,
            "pending": pending, "done": len(tasks) - pending,
            "last_scan": last_scan, "next_scan": next_scan,
            "interval_h": meta.get("interval_h", KB_SCAN_INTERVAL_H)}


def kb_maintenance_add_uncovered(question):
    """AI 对话召回为空 → 先查语雀知识库（基准）再定性质：
    语雀有相关文档 → 待拉回/同步；语雀也没有 → 真未覆盖需补知识。"""
    q = (question or "").strip()
    if not q:
        return
    store = _kb_maintenance_load()
    for t in store["tasks"]:
        if t["type"] == "uncovered" and t["title"] == q:
            return
    cue, matched = "missing", []
    qt = _tok_set(q)
    if qt:
        for d in _yuque_fetch_docs():
            dt = _tok_set(d.get("title"))
            if not dt:
                continue
            ov = len(qt & dt) / min(len(qt), len(dt))
            if ov >= 0.34:
                matched.append(d["title"])
        matched = matched[:3]
    if matched:
        cue = "yuque_has"
        desc = f"本地未召回，但语雀知识库有相关文档：{' / '.join(matched)}，建议拉回同步"
    else:
        desc = "本地与语雀知识库均未覆盖该问题，需补充知识"
    store["tasks"].append({
        "id": f"uncovered-{int(time.time())}",
        "type": "uncovered", "title": q,
        "detail": {"question": q, "cue": cue, "yuque_docs": matched,
                   "desc": desc},
        "status": "pending", "resolution": "", "resolved_at": 0,
    })
    _kb_maintenance_save(store)


def kb_maintenance_resolve(task_id, action, note):
    """裁决待办：标记完成 + 冲突类回写 conflicts.md 状态行。"""
    store = _kb_maintenance_load()
    hit = next((t for t in store["tasks"] if t["id"] == task_id), None)
    if not hit:
        return {"success": False, "message": "待办不存在"}
    resolution = action + (f"：{note}" if note else "")
    hit["status"] = "done"
    hit["resolution"] = resolution
    hit["resolved_at"] = int(time.time() * 1000)
    _kb_maintenance_save(store)
    if hit["type"] == "conflict":
        p = os.path.join(KB_OUT_DIR, "conflicts.md")
        if os.path.exists(p):
            text = open(p, encoding="utf-8").read()
            new_text, n = re.subn(
                r"(## \[" + re.escape(task_id) + r"\][^\n]*\n)- 状态: [^\n]*",
                lambda m: m.group(1) + f"- 状态: 已裁决 - {resolution}",
                text, count=1)
            if n:
                open(p, "w", encoding="utf-8").write(new_text)
    return {"success": True, "task": hit}


def kb_maintenance_chat(task_id, message, history=None):
    """裁决助手对话：带上待办上下文 + 相关知识召回，帮用户裁判。"""
    store = _kb_maintenance_load()
    hit = next((t for t in store["tasks"] if t["id"] == task_id), None)
    if not hit:
        return {"success": False, "message": "待办不存在"}
    d = hit.get("detail") or {}
    ctx = [f"待办类型: {hit['type']}", f"标题: {hit['title']}"]
    if hit["type"] == "conflict":
        ctx += [f"冲突描述: {d.get('desc')}",
                f"说法A: {d.get('say_a')}（来源: {d.get('src_a')}）",
                f"说法B: {d.get('say_b')}（来源: {d.get('src_b')}）",
                f"编译时AI建议: {d.get('suggestion')}"]
        if d.get("full_a"):
            ctx.append(f"说法A切片原文（截断）:\n{str(d.get('full_a'))[:1200]}")
        if d.get("full_b"):
            ctx.append(f"说法B切片原文（截断）:\n{str(d.get('full_b'))[:1200]}")
        recall_q = d.get("issue") or hit["title"]
    elif hit["type"] == "upload_review":
        ctx.append(f"上传文件: {d.get('file')}，共 {d.get('total')} 条，"
                   f"新增 {d.get('new_count')} 条")
        dups = d.get("duplicates") or []
        if dups:
            ctx.append("疑似与语雀重复的条目:\n" + "\n".join(
                f"- 上传《{x.get('upload')}》 ↔ 语雀《{x.get('yuque')}》"
                f"（重叠 {int((x.get('overlap') or 0) * 100)}%）" for x in dups[:10]))
        recall_q = d.get("file") or hit["title"]
    else:
        ctx.append(f"说明: {d.get('desc') or ''}")
        if d.get("yuque_docs"):
            ctx.append(f"语雀相关文档: {' / '.join(d['yuque_docs'])}")
        recall_q = d.get("question") or d.get("topic") or hit["title"]
    hits = _kb_recall_for_chat(recall_q, topk=3)
    if hits:
        ctx.append("相关知识召回:\n" + "\n".join(
            f"- 《{h.get('topic')}》{h.get('title')}: {(h.get('content') or '')[:150]}"
            for h in hits))
    sys_prompt = ("你是知识库维护裁决助手。用户正在处理一条知识维护待办（冲突或未覆盖问题）。"
                  "请基于下面的待办上下文与召回知识，帮助用户分析两种说法的差异、判断哪个更可信/更新，"
                  "或为未覆盖问题草拟答案要点。回答简洁、给出依据，最终裁决由用户做出。\n\n"
                  + "\n".join(ctx))
    msgs = [{"role": "system", "content": sys_prompt}]
    for h in (history or [])[-6:]:
        msgs.append({"role": h.get("role"), "content": h.get("content")})
    msgs.append({"role": "user", "content": message})
    r = direct_chat(msgs)
    if not r.get("success"):
        return r
    return {"success": True, "reply": r["reply"], "task_id": task_id}


# ------------------------------------------------------------
# 定时扫描：以语雀知识库为基准（线上权威源）
# - 漂移/冲突: 语雀文档发布后被人工编辑（与本地分歧）
# - 陈旧: 语雀文档长期未更新
# - 覆盖: 本地召回未命中 → 先查语雀再定「未覆盖/待拉回」
# - 上传新知识: 与语雀对比查重/查冲突
# ------------------------------------------------------------
KB_SCAN_INTERVAL_H = 6      # 扫描间隔（小时）
KB_STALE_DAYS = 180         # 语雀文档超过 N 天未更新视为疑似陈旧
_YUQUE_DOC_CACHE = {"ts": 0.0, "docs": []}


def _yuque_cfg():
    yq = _kb_sync_load().get("yuque", {})
    cfg = yq.get("config") or {}
    return (cfg.get("token") or "",
            cfg.get("api_base") or "https://www.yuque.com",
            (yq.get("namespace") or cfg.get("namespace") or "").strip().strip("/"))


def _yuque_fetch_docs(with_body=False, ttl=1800):
    """语雀文档列表 [{id,title,updated_at,body?}]；未配置/失败返回 []。
    元数据带缓存（ttl 秒），ttl=0 强制拉新。"""
    token, api_base, ns = _yuque_cfg()
    if not token or not ns:
        return []
    now = time.time()
    if (not with_body and ttl and _YUQUE_DOC_CACHE["ts"]
            and now - _YUQUE_DOC_CACHE["ts"] < ttl and _YUQUE_DOC_CACHE["docs"]):
        return _YUQUE_DOC_CACHE["docs"]
    base = api_base.rstrip("/") + "/api/v2/repos/" + ns
    try:
        r = _yuque_api("GET", base + "/docs?limit=100", token)
        docs = [{"id": d.get("id"), "title": d.get("title") or "",
                 "updated_at": d.get("content_updated_at") or d.get("updated_at") or ""}
                for d in r.get("data", [])]
        if with_body:
            for doc in docs:
                try:
                    rr = _yuque_api("GET", f"{base}/docs/{doc['id']}?raw=1", token)
                    doc["body"] = (rr.get("data") or {}).get("body") or ""
                except Exception:
                    doc["body"] = ""
        if not with_body:
            _YUQUE_DOC_CACHE["ts"] = now
            _YUQUE_DOC_CACHE["docs"] = docs
        return docs
    except Exception as e:
        log(f"yuque fetch docs failed: {e}")
        return []


def _tok_set(text):
    sys.path.insert(0, os.path.dirname(KB_OUT_DIR))
    import kb_compiler as kbc  # noqa
    return set(kbc.tokenize(text or ""))


def _kb_scan_yuque_stale():
    """以语雀为基准的陈旧检出：文档长期未更新。"""
    docs = _yuque_fetch_docs(with_body=False, ttl=0)
    aged_ts = time.time() - KB_STALE_DAYS * 86400
    out = []
    for d in docs:
        try:
            ts = datetime.fromisoformat(
                d["updated_at"].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        if ts < aged_ts:
            out.append({"topic": d["title"], "updated_at": d["updated_at"]})
    return out


def kb_maintenance_scan():
    """维护扫描（语雀为基准）：本地冲突台账同步 + 语雀漂移/陈旧检出。
    定时调度与手动触发共用。"""
    kb_maintenance_list()  # 同步本地编译时冲突台账（次要来源）
    store = _kb_maintenance_load()
    existing = {t["id"]: t for t in store["tasks"]}
    added = 0
    drift_topics = []
    # 1) 语雀漂移：发布后被人工编辑 → 与本地分歧，需裁决（拉回 or 覆盖）
    chk = kb_check_conflict("", "")
    for s in (chk.get("stale") or []) if chk.get("success") else []:
        tid = f"ydrift-{s['topic']}"
        desc = (f"《{s['topic']}》在语雀端被人工编辑（{s.get('remote_updated_at', '')}），"
                "与本地版本分歧，需裁决：拉回语雀编辑 或 用本地版覆盖")
        if tid in existing:
            continue
        existing[tid] = {"id": tid, "type": "yuque_drift", "title": desc,
                         "detail": {"topic": s["topic"], "desc": desc,
                                    "remote_updated_at": s.get("remote_updated_at", "")},
                         "status": "pending", "resolution": "", "resolved_at": 0}
        added += 1
        drift_topics.append(s["topic"])
    # 2) 语雀陈旧：文档长期未更新
    for s in _kb_scan_yuque_stale():
        tid = f"ystale-{s['topic']}"
        desc = (f"《{s['topic']}》语雀文档超过 {KB_STALE_DAYS} 天未更新"
                f"（最后更新 {s['updated_at'][:10]}），建议复核内容时效性")
        if tid in existing:
            continue
        existing[tid] = {"id": tid, "type": "stale", "title": desc,
                         "detail": {"topic": s["topic"], "desc": desc,
                                    "updated_at": s["updated_at"]},
                         "status": "pending", "resolution": "", "resolved_at": 0}
        added += 1
    store["tasks"] = list(existing.values())
    store["meta"] = {"last_scan": int(time.time() * 1000),
                     "interval_h": KB_SCAN_INTERVAL_H,
                     "stale_days": KB_STALE_DAYS,
                     "yuque_configured": bool(_yuque_cfg()[0])}
    _kb_maintenance_save(store)
    log(f"kb scan: +{added} tasks (drift={len(drift_topics)})")
    # 漂移主题 → 后台自动刷新摘要与标签，保持检索上下文新鲜
    if drift_topics:
        threading.Thread(
            target=lambda: kb_maintenance_refresh_topics(sorted(drift_topics)),
            daemon=True).start()
    return {"success": True, "added": added,
            "total": len(store["tasks"]),
            "last_scan": store["meta"]["last_scan"],
            "yuque_configured": store["meta"]["yuque_configured"],
            "auto_refreshed_topics": sorted(drift_topics)}


def _kb_scan_loop():
    """定时扫描线程：启动后先扫一次，之后每 KB_SCAN_INTERVAL_H 小时一次。"""
    time.sleep(10)
    while True:
        try:
            kb_maintenance_scan()
        except Exception as e:
            log(f"kb scan loop error: {e}")
        time.sleep(KB_SCAN_INTERVAL_H * 3600)


def kb_maintenance_refresh_topics(topics=None):
    """LLM 刷新主题摘要 + 标签（keywords），写回 index.json（先备份）。
    topics=None → 全部主题。"""
    idx_p = os.path.join(KB_OUT_DIR, "index.json")
    if not os.path.exists(idx_p):
        return {"success": False, "message": "知识库未编译"}
    idx = json.load(open(idx_p, encoding="utf-8"))
    targets = topics or list(idx.get("topics", {}).keys())
    refreshed = []
    for tn in targets:
        t = idx["topics"].get(tn)
        if not t:
            continue
        parts = []
        for sid in t.get("slice_ids", [])[:40]:
            s = idx["slices"].get(sid)
            if s:
                parts.append(f"- {s['title']}: {(s.get('content') or '')[:120]}")
        if not parts:
            continue
        prompt = ("你是知识库管理员。根据下面的客服知识切片列表，为主题《" + tn +
                  "》生成：\n1. summary：60~120 字主题摘要（覆盖主要业务场景）\n"
                  "2. keywords：5~8 个主题标签（业务术语，供检索与路由）\n"
                  "严格只返回 JSON：{\"summary\",\"keywords\"}\n\n" + "\n".join(parts))
        r = direct_chat([{"role": "user", "content": prompt}])
        if not r.get("success"):
            log(f"refresh topic {tn} failed: {r.get('message')}")
            continue
        m = re.search(r"\{[\s\S]*\}", r["reply"])
        try:
            meta = json.loads(m.group(0) if m else r["reply"])
        except Exception:
            continue
        t["overview_llm"] = (meta.get("summary") or "").strip()
        t["keywords_llm"] = meta.get("keywords") or []
        t["refreshed_at"] = int(time.time() * 1000)
        refreshed.append(tn)
        log(f"refresh topic: {tn} -> {len(t['keywords_llm'])} keywords")
    if refreshed:
        bak = idx_p + ".prev"
        if os.path.exists(idx_p):
            shutil.copy2(idx_p, bak)
        with open(idx_p, "w", encoding="utf-8") as f:
            json.dump(idx, f, ensure_ascii=False)
    return {"success": True, "refreshed": refreshed,
            "total_topics": len(idx.get("topics", {}))}


def _kb_run_build(engine="builtin"):
    global _kb_build_proc
    sources = sorted(os.path.join(KB_SRC_DIR, f)
                     for f in os.listdir(KB_SRC_DIR)
                     if f.endswith(".xlsx"))
    if not sources:
        _kb_write_status("error", "sources/ 下没有 .xlsx 源文件")
        return
    # 备份旧索引用于 diff
    cur = os.path.join(KB_OUT_DIR, "index.json")
    if os.path.exists(cur):
        import shutil
        shutil.copy(cur, os.path.join(KB_OUT_DIR, "index.prev.json"))
    _kb_write_status("running", f"编译 {len(sources)} 个源文件（engine={engine}）")
    cmd = [sys.executable, "-u",  # -u 无缓冲，编译进度日志可实时 tail
           os.path.join(KB_COMPILER_DIR, "kb_compiler.py"),
           "compile", "--xlsx", *sources, "--out", KB_OUT_DIR,
           "--engine", engine]
    try:
        with open(KB_BUILD_LOG, "w", encoding="utf-8") as logf:
            _kb_build_proc = subprocess.Popen(
                cmd, stdout=logf, stderr=subprocess.STDOUT,
                cwd=KB_COMPILER_DIR)
            code = _kb_build_proc.wait()
        _kb_write_status("done" if code == 0 else "error",
                         f"退出码 {code}" if code else "编译完成")
    except Exception as e:
        _kb_write_status("error", str(e))


def kb_start_build(engine="builtin"):
    global _kb_build_proc
    if engine not in ("builtin", "llmwiki"):
        return {"success": False, "message": f"未知编译引擎: {engine}"}
    if _kb_build_proc is not None and _kb_build_proc.poll() is None:
        return {"success": False, "message": "已有编译任务进行中"}
    if not os.path.exists(os.path.join(KB_COMPILER_DIR, "kb_compiler.py")):
        return {"success": False, "message": "未找到 kb_compiler.py"}
    threading.Thread(target=_kb_run_build, args=(engine,), daemon=True).start()
    return {"success": True, "message": f"编译已启动（engine={engine}）"}


# ============================================================
# HTTP 服务
# ============================================================

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _read_raw_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        port = int(qs.get("port", [DEFAULT_CDP_PORT])[0])
        try:
            if path == "/api/health":
                self._json(200, {"ok": True, "service": "iboss-login"})
            elif path == "/api/login/status":
                st = check_login_status(port)
                has_cred, cred_user = has_credential()
                st["credential_saved"] = has_cred
                st["credential_user"] = cred_user
                self._json(200, st)
            elif path == "/api/login/credentials":
                has_cred, cred_user = has_credential()
                self._json(200, {"saved": has_cred, "username": cred_user})
            elif path == "/api/login/tenants":
                self._json(200, {"tenants": IBOSS_TENANTS, "default": DEFAULT_TENANT})
            elif path == "/api/instances":
                self._json(200, {"instances": list_instances()})
            elif path == "/api/apps/status":
                app_key = qs.get("app", [""])[0] or "cockpit"
                self._json(200, get_app_status(app_key))
            elif path == "/api/cockpit/persona":
                persona = read_persona_section()
                self._json(200, {"synced": persona is not None,
                                 "content": persona or "", "path": CLAUDE_MD})
            elif path == "/api/chat/bridge":
                conn = get_bridge_conn()
                alive = bridge_alive(conn)
                model_cfg = load_model_api_config()
                self._json(200, {
                    "connected": bool(conn and alive),
                    "captured": bool(conn),
                    "port": (conn or {}).get("port"),
                    "cockpit_running": get_app_status("cockpit")["running"],
                    "direct_api_available": bool(model_cfg),
                    "direct_model": (model_cfg or {}).get("model"),
                })
            elif path == "/api/kb/topics":
                self._json(200, kb_topics())
            elif path == "/api/kb/topic":
                self._json(200, kb_topic(qs.get("name", [""])[0]))
            elif path == "/api/kb/search":
                self._json(200, kb_search(qs.get("q", [""])[0],
                                          int(qs.get("topk", ["3"])[0])))
            elif path == "/api/kb/sync":
                self._json(200, kb_sync_status())
            elif path == "/api/kb/sources":
                self._json(200, kb_list_sources())
            elif path == "/api/kb/build":
                self._json(200, kb_build_status())
            elif path == "/api/kb/conflict":
                self._json(200, kb_check_conflict(
                    qs.get("token", [""])[0], qs.get("namespace", [""])[0],
                    qs.get("api_base", ["https://www.yuque.com"])[0]))
            elif path == "/api/kb/maintenance":
                self._json(200, kb_maintenance_list())
            elif path == "/api/smart-chain/templates":
                self._json(200, smart_chain_templates())
            elif path == "/api/smart-chain/template":
                self._json(200, smart_chain_template_detail(
                    qs.get("name", [""])[0]))
            elif path == "/api/smart-chain/detect":
                self._json(200, smart_chain_detect_status(
                    qs.get("job", [""])[0]))
            elif path == "/api/smart-chain/run":
                self._json(200, smart_chain_run_status(
                    qs.get("job", [""])[0]))
            elif path == "/api/workflows":
                self._json(200, workflows_list())
            elif path == "/api/workflow/run":
                self._json(200, workflow_run_status(
                    qs.get("run_id", [""])[0]))
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/kb/upload":
            # 二进制上传：文件名走 X-Filename 头（URL 编码），须在 JSON 解析前读原始流
            self._json(200, kb_upload_source(
                urllib.parse.unquote(self.headers.get("X-Filename") or ""),
                self._read_raw_body()))
            return
        body = self._read_body()
        tenant = body.get("tenant") or ""
        port = resolve_port(body.get("port"), tenant)
        try:
            if path == "/api/login/status":
                st = check_login_status(port)
                self._json(200, st)
            elif path == "/api/login/credentials":
                username = (body.get("username") or "").strip()
                password = body.get("password") or ""
                if not username or not password:
                    self._json(400, {"error": "工号和密码不能为空"})
                    return
                ok = save_credential(username, password)
                self._json(200, {"success": ok, "username": username})
            elif path == "/api/login/relogin":
                self._json(200, do_sso_relogin(port, tenant or DEFAULT_TENANT))
            elif path == "/api/login/tab":
                url = body.get("url") or TARGET_HOME_URL
                self._json(200, open_tab(port, url))
            elif path == "/api/instances/start":
                self._json(200, start_instance(tenant))
            elif path == "/api/instances/stop":
                self._json(200, stop_instance(port))
            elif path == "/api/apps/launch":
                self._json(200, launch_app(body.get("app") or "cockpit"))
            elif path == "/api/cockpit/persona":
                self._json(200, sync_persona(body.get("content") or ""))
            elif path == "/api/chat/send":
                msg = (body.get("message") or "").strip()
                if not msg:
                    self._json(400, {"success": False, "message": "消息不能为空"})
                    return
                self._json(200, chat_send_auto(
                    msg, body.get("sessionId"), body.get("history") or []))
            elif path == "/api/chat/sessions":
                self._json(200, rpc_call("session.list", {"limit": 20}))
            elif path == "/api/chat/bridge/reset":
                self._json(200, restart_cockpit_for_bridge())
            elif path == "/api/kb/publish":
                self._json(200, kb_publish(body))
            elif path == "/api/kb/compile":
                self._json(200, kb_start_build(body.get("engine") or "builtin"))
            elif path == "/api/kb/pull":
                self._json(200, kb_pull_yuque(
                    body.get("token") or "", body.get("namespace") or "",
                    body.get("api_base") or "https://www.yuque.com"))
            elif path == "/api/smart-chain/template":
                self._json(200, smart_chain_save_template(
                    body.get("template") or {}))
            elif path == "/api/smart-chain/template/delete":
                self._json(200, smart_chain_delete_template(
                    body.get("name") or ""))
            elif path == "/api/smart-chain/detect":
                self._json(200, smart_chain_detect_start(body))
            elif path == "/api/smart-chain/run":
                self._json(200, smart_chain_run_start(body))
            elif path == "/api/smart-chain/suggest-meta":
                self._json(200, smart_chain_suggest_meta(
                    body.get("template") or {}))
            elif path == "/api/workflows/save":
                self._json(200, workflow_save(body.get("workflow") or {}))
            elif path == "/api/workflows/delete":
                self._json(200, workflow_delete(body.get("id") or ""))
            elif path == "/api/workflows/suggest-sop":
                self._json(200, workflow_suggest_sop(body))
            elif path == "/api/workflows/suggest-meta":
                self._json(200, workflow_suggest_meta(body.get("workflow") or {}))
            elif path == "/api/workflow/run":
                self._json(200, workflow_run_start(body))
            elif path == "/api/kb/maintenance/resolve":
                self._json(200, kb_maintenance_resolve(
                    body.get("task_id") or "", body.get("action") or "",
                    body.get("note") or ""))
            elif path == "/api/kb/maintenance/scan":
                self._json(200, kb_maintenance_scan())
            elif path == "/api/kb/maintenance/refresh":
                self._json(200, kb_maintenance_refresh_topics(
                    body.get("topics") or None))
            elif path == "/api/kb/maintenance/chat":
                self._json(200, kb_maintenance_chat(
                    body.get("task_id") or "", body.get("message") or "",
                    body.get("history") or []))
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        # 静默默认访问日志，避免泄露敏感参数
        pass


def main():
    global DEFAULT_CDP_PORT, DEFAULT_TENANT
    parser = argparse.ArgumentParser(description="iboss login service for skill-workbench")
    parser.add_argument("--port", type=int, default=18890, help="HTTP 服务端口")
    parser.add_argument("--cdp-port", type=int, default=DEFAULT_CDP_PORT,
                        help="默认 CDP 端口")
    parser.add_argument("--tenant", default=DEFAULT_TENANT,
                        help="默认租户 ID（见 local_settings.TENANT_DEFS）")
    args = parser.parse_args()
    DEFAULT_CDP_PORT = args.cdp_port
    DEFAULT_TENANT = args.tenant

    threading.Thread(target=bridge_watcher, daemon=True).start()
    log("bridge watcher started (handshake: ~/.openclaw-bundle/app-tool-bridge.json)")
    threading.Thread(target=_kb_scan_loop, daemon=True).start()
    log(f"kb maintenance scheduler started (every {KB_SCAN_INTERVAL_H}h, "
        f"stale>{KB_STALE_DAYS}d)")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"iboss login service listening on http://127.0.0.1:{args.port} "
        f"(default CDP={args.cdp_port}, tenant={args.tenant})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
