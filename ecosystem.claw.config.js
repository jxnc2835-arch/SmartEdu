// PM2 进程守护配置 —— 学管 SmartEdu（Claw 目录，3100/3543）
//
// 与线上「学管 SmartEdu」(ecosystem.config.js, 3000/3443, app 名 smartedu) 完全隔离：
//   - 本 app 名 smartedu-claw，cwd 指向 Claw 目录
//   - 端口由本目录 .env 决定（PORT=3100 / HTTPS_PORT=3543），不从 pm2 env 注入
//   - 独立守护，崩溃自动拉起，互不影响
//
// 用法（需先 npm install -g pm2）：
//   pm2 start ecosystem.claw.config.js      # 启动守护（Claw 3100/3543）
//   pm2 logs smartedu-claw                  # 看日志
//   pm2 stop smartedu-claw / pm2 restart smartedu-claw
//   pm2 save && pm2 startup                 # 保存并注册开机自启（Windows 需 pm2-startup 或计划任务）
module.exports = {
  apps: [
    {
      name: 'smartedu-claw',
      script: 'server.js',
      // 指向 Claw 目录，确保加载本目录的 .env / config / data
      cwd: __dirname,
      // 解释器走 PATH 中的 node（不再硬编码本机 WorkBuddy 托管路径），便于整套部署到任意机器：
      // 目标机只需安装 Node（建议 22.x）且 node 在 PATH 即可，无需复制 WorkBuddy 运行时。
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      // 不 watch：文件变更不自动重启（手动控制重启节奏，避免热改代码时反复拉）
      watch: false,
      // 端口由本目录 .env 提供（PORT=3100 / HTTPS_PORT=3543），这里不覆盖，
      // 防止 pm2 env 与 .env 不一致触发 server.js 的 EADDRINUSE 自增逻辑。
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/pm2-claw-error.log',
      out_file: 'logs/pm2-claw-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
