// PM2 托管 Cloudflare Tunnel —— 公网穿透（Windows 目标机）
//
// 作用：把本机 http://localhost:3100（学管 SmartEdu）暴露为公网 HTTPS 地址，
//      手机 / 异地直接用浏览器打开即可访问，无需公网 IP、无需改路由器、免费。
//
// 前置（目标机，仅需做一次）：
//   1) 安装 cloudflared 并加入 PATH：
//        winget install Cloudflare.cloudflared
//      （若 winget 不通 / GFW 下载慢，见《部署与运维说明_Windows公网版.md》的备用下载与代理方案）
//   2) 先确保 smartedu-claw 已用 ecosystem.claw.config.js 启动并 pm2 save
//
// 用法：
//   pm2 start ecosystem.tunnel.config.js
//   pm2 save        # 连同 server 一起固化；开机自启（pm2-startup）时会一并拉起
//   pm2 logs smartedu-tunnel
//
// 默认是「快速隧道」：随机公网地址，无需 Cloudflare 账号，适合演示。
// 想要「稳定不变的公网地址」，改用命名隧道（见说明文档的命名隧道章节），
// 把下方 args 改为：  tunnel run --url http://localhost:3100 <你的隧道名>
//
// 注意：client 侧由 Cloudflare 提供 HTTPS（*.trycloudflare.com），无需自签证书。

module.exports = {
  apps: [
    {
      name: 'smartedu-tunnel',
      // 走 PATH 中的 cloudflared；若未加入 PATH，改为绝对路径，例如：
      //   script: 'C:/Program Files/cloudflared/cloudflared.exe'
      script: 'cloudflared',
      interpreter: 'none',           // 非 Node 程序，PM2 直接 spawn
      args: 'tunnel --url http://localhost:3100',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      env: { NODE_ENV: 'production' },
      error_file: 'logs/pm2-tunnel-error.log',
      out_file: 'logs/pm2-tunnel-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
