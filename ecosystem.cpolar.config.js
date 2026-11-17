/**
 * PM2 配置：cpolar 内网穿透（国产，国内访问稳，师生零安装）
 * 作用：把本机 http://localhost:3100 映射成公网 HTTPS 地址，
 *       使老师/学生在任何网络（校园/家里/手机流量）都能登录，不限制校园网。
 * 主机仍在辅导员那台 Windows 电脑 24h 在线，数据留院内。
 *
 * 前置：
 *   1. 安装 cpolar（deploy.bat 已内置自动下载；或官网 https://www.cpolar.com 下载放 System32）
 *   2. 一次性绑定 token：cpolar authtoken <你的token>（token 在 cpolar 控制台复制）
 *
 * 用法：
 *   pm2 start ecosystem.cpolar.config.js
 *   pm2 save            # 连同 server 一起固化，开机自启时一并拉起
 *   pm2 logs smartedu-cpolar   # 日志里找 *.cpolar.io / *.cpolar.cn 的公网地址
 *
 * 固定地址（付费档）：cpolar 控制台「保留二级子域名」后，把下方 args 改为
 *   args: 'http -subdomain=你的固定名 3100'
 * 再 pm2 restart smartedu-cpolar 即可。
 */
module.exports = {
  apps: [
    {
      name: 'smartedu-cpolar',
      script: 'cpolar',
      interpreter: 'none', // 直接用系统 cpolar 可执行文件，不经由 node
      args: 'http 3100',
      autorestart: true,
      max_restarts: 10,
      min_uptime: 5000,
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
