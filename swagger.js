/**
 * swagger.js - API 文档自动生成
 * 基于 JSDoc 注解自动生成 OpenAPI 3.0 规范文档
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
        version: '3.6.2',
        description: 'AI 智能化学生管理系统 REST API\n\n## 认证说明\n- 所有需要认证的接口需在请求头中携带 `x-auth-token`\n- CSRF 保护：POST/PUT/DELETE 请求需在请求体或 Header 中携带 `_csrf` token\n- Token 获取：POST /api/login 成功后返回\n- CSRF Token 获取：GET /api/csrf-token（需先登录）\n\n## 安全特性\n- JWT Token 认证\n- CSRF Token 防护\n- HTTPS 强制重定向\n- SQL 参数化查询\n- 文件上传白名单校验',
        contact: {
          name: 'SmartEdu Team',
          email: 'support@smartedu.com'
        },
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT'
        }
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: '本地开发环境'
        },
        {
          url: 'https://localhost:3443',
          description: 'HTTPS 生产环境'
        }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: '通过 x-auth-token 请求头传递 JWT Token'
          },
          csrfToken: {
            type: 'apiKey',
            in: 'header',
            name: 'x-csrf-token',
            description: 'CSRF Token，通过 GET /api/csrf-token 获取'
          }
        },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              code: { type: 'integer', example: 1 },
              message: { type: 'string', example: '错误信息' }
            }
          },
          Success: {
            type: 'object',
            properties: {
              code: { type: 'integer', example: 0 },
              message: { type: 'string', example: '操作成功' },
              data: { type: 'object', description: '响应数据' }
            }
          },
          Pagination: {
            type: 'object',
            properties: {
              page: { type: 'integer', example: 1 },
              pageSize: { type: 'integer', example: 20 },
              total: { type: 'integer', example: 100 },
              totalPages: { type: 'integer', example: 5 }
            }
          },
          LoginRequest: {
            type: 'object',
            required: ['username', 'password'],
            properties: {
              username: { type: 'string', example: 'admin' },
              password: { type: 'string', example: 'admin123' }
            }
          },
          LoginResponse: {
            type: 'object',
            properties: {
              code: { type: 'integer', example: 0 },
              token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
              expiresIn: { type: 'integer', example: 7200 },
              data: {
                type: 'object',
                properties: {
                  userId: { type: 'string', example: '1' },
                  username: { type: 'string', example: 'admin' },
                  displayName: { type: 'string', example: '管理员' },
                  role: { type: 'string', example: 'admin' }
                }
              }
            }
          },
          Student: {
            type: 'object',
            properties: {
              id: { type: 'integer', example: 1 },
              studentId: { type: 'string', example: '2024001' },
              name: { type: 'string', example: '张三' },
              gender: { type: 'string', enum: ['男生', '女生'] },
              className: { type: 'string', example: '计算机科学与技术1班' },
              dorm: { type: 'string', example: 'A栋101' },
              phone: { type: 'string', example: '13800138000' },
              faceHash: { type: 'string', nullable: true, description: '人脸特征向量JSON' }
            }
          },
          CheckinRecord: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'rec_20240911_001' },
              studentId: { type: 'string', example: '2024001' },
              date: { type: 'string', example: '2024-09-11' },
              time: { type: 'string', example: '08:00:00' },
              type: { type: 'string', enum: ['checkin', 'class'] },
              status: { type: 'string', enum: ['在寝', '未归', '晚归', '不在寝', '缺席', '请假'] },
              note: { type: 'string', nullable: true },
              latitude: { type: 'number', nullable: true },
              longitude: { type: 'number', nullable: true },
              address: { type: 'string', nullable: true }
            }
          },
          LeaveRequest: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'leave_20240911_001' },
              studentId: { type: 'string', example: '2024001' },
              type: { type: 'string', enum: ['事假', '病假', '公假', '丧假'] },
              reason: { type: 'string', example: '身体不适' },
              startDate: { type: 'string', example: '2024-09-11' },
              endDate: { type: 'string', example: '2024-09-12' },
              status: { type: 'string', enum: ['待审批', '已批准', '已驳回'] },
              createdAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      },
      security: [{ bearerAuth: [] }]
    },
    apis: [
      './routes/**/*.js',
      './middleware/**/*.js'
    ]
  });

  // 补充 Swagger UI 配置
  const swaggerOptions = {
    swaggerUI: {
      displayOperationId: true,
      displayRequestDuration: true,
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 2,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha'
    },
    explorer: true
  };

  // 挂载 Swagger UI
  app.use('/swagger', swaggerUi.serve, swaggerUi.setup(spec, swaggerOptions));
  
  // 暴露原始 OpenAPI JSON
  app.get('/swagger.json', (req, res) => res.json(spec));
  
  // API 根路径重定向到 Swagger
  app.get('/api', (req, res) => {
    res.redirect('/swagger');
  });

  console.log('Swagger 文档已挂载: http://localhost:3000/swagger');
}

module.exports = initSwagger;
