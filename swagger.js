/**
 * swagger.js - API 文档
 * 使用已安装的 swagger-jsdoc + swagger-ui-express，在 /swagger 挂载 OpenAPI 文档。
 * 之前该文件缺失，导致：
 *   1) 本地 server.js 报 "Swagger 初始化失败"（被 try/catch 吞掉）；
 *   2) Dockerfile 中 `COPY swagger.js ./` 在构建时直接失败。
 * 现提供最小可用实现：挂载 Swagger UI + 基础 OpenAPI schema（覆盖主要端点）。
 */

const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

/**
 * 初始化 Swagger 文档并挂载到 Express 应用
 * @param {object} app - Express 应用实例
 */
function initSwagger(app) {
  const spec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: '学管 SmartEdu API',
        version: '3.6.0',
        description: 'AI 智能化学生管理系统 REST API'
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
        }
      },
      security: [{ bearerAuth: [] }]
    },
    // 从 routes/ 目录扫描 JSDoc @swagger 注解（若后续补充可自动收录更多端点）
    apis: [
      'routes/**/*.js',
      { openapi: '3.0.0' }
    ],
    // 显式补充主要端点，保证即使 routes 无注解，UI 也有可用文档
    ...{ apis: [] }
  });

  // 将主要端点并入 spec（避免依赖分散的 JSDoc 注解）
  spec.paths = Object.assign(spec.paths || {}, {
    '/health': {
      get: {
        tags: ['system'],
        summary: '健康检查',
        security: [],
        responses: { 200: { description: 'ok' } }
      }
    },
    '/api/login': {
      post: {
        tags: ['auth'],
        summary: '管理员/辅导员登录',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string' },
                  password: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: '登录成功，返回 JWT token',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    code: { type: 'integer', example: 0 },
                    token: { type: 'string' },
                    expiresIn: { type: 'integer' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/stats': {
      get: {
        tags: ['statistics'],
        summary: '综合统计（按天数/班级）',
        parameters: [
          { name: 'days', in: 'query', schema: { type: 'integer' }, example: 7 },
          { name: 'class_name', in: 'query', schema: { type: 'string' } }
        ],
        responses: { 200: { description: 'ok' } }
      }
    },
    '/api/needs': {
      get: {
        tags: ['system'],
        summary: '获取 README 中的后续改进计划',
        security: [],
        responses: { 200: { description: 'ok' } }
      }
    }
  });

  app.use('/swagger', swaggerUi.serve, swaggerUi.setup(spec));
  // 暴露原始 OpenAPI JSON
  app.get('/swagger.json', (req, res) => res.json(spec));
}

module.exports = initSwagger;
