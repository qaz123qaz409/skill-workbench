# ============================================================
# 本地私有配置（含内网地址/租户默认值）—— 已被 .gitignore 排除，不会进 git
# 仓库里只有 local_settings.example.py 占位模板
# ============================================================

# iboss 目标站点（内网 SSO）
TARGET_HOST = "iboss.example-internal.com"
TARGET_HOME_URL = "https://iboss.example-internal.com/portal/dashboard"
TARGET_CHECK_SESSION_PATH = "/portal/checkSession.json"
SSO_LOGIN_URL = (
    "https://sso.example-internal.com/login.htm"
    "?goto=" + urllib.parse.quote(TARGET_HOME_URL, safe="")
)

# 默认租户（ tenants.local.ts 同步维护 ）
DEFAULT_TENANT = "TENANT0001"

# 租户清单（SSO 登录页 tenant 下拉；port 按顺序从 9301 递增）
TENANT_DEFS = [
    ("TENANT0001", "Tenant 01 | 说明"),
    ("TENANT0002", "Tenant 02 | 说明"),
]

# 语雀（企业内网部署时替换，公网用官方默认即可）
YUQUE_INTERNAL_API_BASE = "https://yuque-api.example-internal.com"
YUQUE_INTERNAL_WEB_BASE = "https://yuque.example-internal.com"
SSO_AUTH_MARKER = "sso.example-internal.com/auth.htm"
