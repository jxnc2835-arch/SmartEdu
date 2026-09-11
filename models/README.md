# ==================== 服务端人脸识别模型目录 ====================
# 存放 face-api.js / @vladmandic/face-api 所需的模型权重文件。
# 模型由 face-api 库在首次加载时自动下载，也可手动放置于此。
#
# 文件列表(均为 face-api.js 0.20 / @vladmandic/face-api 所需):
#   tiny_face_detector_model-{shard*,weights_manifest.json}
#   face_landmark_68_model-{shard*,weights_manifest.json}
#   face_recognition_model-{shard*,weights_manifest.json}
#
# 前端(teacher.html / student.html)也使用同目录下的 public/models/, 两者互不干扰:
#   - 此 models/    : Node 服务端推理(懒加载, 首次登录时触发)
#   - public/models/: 浏览器 CDN 兜底 + 本地优先的实时签到模型
