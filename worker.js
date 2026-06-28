/**
 * =================================================================================
 * 项目: pixarmory-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Phantom Artist)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-03
 * 
 * [核心特性]
 * 1. [无痕伪装] 自动生成 Vercel 追踪 ID 和浏览器指纹，模拟匿名用户，无需 Cookie 即可运行。
 * 2. [多模态支持] 完美兼容 OpenAI Vision 格式，支持 Base64 图片自动上传至 PixArmory R2 存储桶。
 * 3. [多图参考] 突破性支持多张参考图（Web UI 支持多选，API 支持多 image_url）。
 * 4. [开发者驾驶舱] 内置全中文、高颜值的调试界面，包含实时日志和 cURL 生成器。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "pixarmory-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置)
  API_MASTER_KEY: "1", 
  
  // 上游配置
  UPSTREAM_ORIGIN: "https://pixarmory.org",
  
  // 模型列表 (映射到 PixArmory 的内部逻辑)
  // 用户可以使用这些模型名称来触发服务
  MODELS: [
    "pixarmory-v1",
    "pixarmory-flux",
    "gpt-4o",      // 兼容性映射
    "dall-e-3",    // 兼容性映射
    "midjourney"   // 兼容性映射
  ],
  DEFAULT_MODEL: "pixarmory-v1",

  // 伪装配置 - 浏览器指纹池
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  ]
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 环境变量覆盖
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    // 允许通过环境变量注入 Cookie，虽然 PixArmory 匿名可用，但带上 Cookie 可能更稳定
    const staticCookie = env.PIXARMORY_COOKIE || ""; 
    
    request.ctx = { apiKey, staticCookie };

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 路由分发
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    if (url.pathname === '/proxy/upload') return handleProxyUpload(request); // 代理前端上传
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑 (Identity & Logic)] ---

// 1. 身份管理器：生成高度逼真的匿名身份
class IdentityManager {
  static getHeaders(staticCookie = "") {
    const ua = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    const requestId = crypto.randomUUID();
    
    // [关键] 构造伪造的 Vercel ID，格式参考抓包数据: cdg1::iad1::mtcrb-1764766848386-58e792ec999f
    const timestamp = Date.now();
    const randomPart = Math.random().toString(36).substring(2, 14);
    const vercelId = `cdg1::iad1::${randomPart}-${timestamp}-${Math.random().toString(16).substring(2, 10)}`;
    
    const headers = {
      "Host": "pixarmory.org",
      "Origin": "https://pixarmory.org",
      "Referer": "https://pixarmory.org/",
      "User-Agent": ua,
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/json",
      "x-vercel-id": vercelId,
      "x-request-id": requestId,
      "priority": "u=1, i",
      "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120", "Not_A Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin"
    };

    // 如果有静态 Cookie 则使用，否则不发送 Cookie (模拟纯匿名新用户)
    if (staticCookie) {
      headers["Cookie"] = staticCookie;
    }

    return headers;
  }
}

// 2. 上传逻辑：处理 R2 预签名上传 (两阶段)
async function uploadImageToR2(fileBlob, fileName, fileType, ctx) {
  const headers = IdentityManager.getHeaders(ctx.staticCookie);
  
  // Phase 1: 获取上传 URL
  // 抓包: POST /api/upload-url
  const initRes = await fetch(`${CONFIG.UPSTREAM_ORIGIN}/api/upload-url`, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      fileName: fileName,
      fileType: fileType,
      fileSize: fileBlob.size
    })
  });

  if (!initRes.ok) {
    throw new Error(`获取上传地址失败: ${initRes.status} ${await initRes.text()}`);
  }

  const initData = await initRes.json();
  const { uploadUrl, accessUrl } = initData;

  // Phase 2: 执行 PUT 上传到 Cloudflare R2
  // 注意：上传到 R2 需要移除大部分 headers，只保留 Content-Type 等
  const uploadHeaders = {
    "Content-Type": fileType,
    "User-Agent": headers["User-Agent"]
  };

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: fileBlob
  });

  if (!uploadRes.ok) {
    throw new Error(`上传图片到 R2 失败: ${uploadRes.status}`);
  }

  return accessUrl;
}

// 3. 生成逻辑：调用核心 API
async function generateImage(prompt, imageUrls = [], ctx) {
  const headers = IdentityManager.getHeaders(ctx.staticCookie);
  
  // 构造 Payload
  // 抓包: {"imageUrls":[...], "prompt":"...", "toolType":"general"}
  const payload = {
    imageUrls: imageUrls, // 支持多张图片
    prompt: prompt,
    toolType: "general"
  };

  const res = await fetch(`${CONFIG.UPSTREAM_ORIGIN}/api/process-image`, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`生成请求失败 (${res.status}): ${errText}`);
  }

  const data = await res.json();
  
  // 处理响应
  // 抓包显示成功时直接返回 processedImageUrl
  if (data.processedImageUrl) {
    return {
      url: data.processedImageUrl,
      creditsUsed: data.creditsUsed,
      remainingCredits: data.remainingCredits
    };
  } else if (data.taskId) {
    // 如果返回 taskId，说明变成了异步 (虽然抓包是同步的，但为了健壮性预留分支)
    // 简单起见，这里抛出错误，或者后续可以实现轮询
    throw new Error("上游返回了异步任务 ID，当前版本暂不支持轮询模式 (请重试)。");
  } else if (data.error) {
    throw new Error(`上游业务错误: ${data.error}`);
  } else {
    throw new Error("上游响应格式未知: " + JSON.stringify(data));
  }
}

// --- [第四部分: API 接口处理] ---

async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return new Response(JSON.stringify({
      object: 'list',
      data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'pixarmory' }))
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }
  
  if (url.pathname === '/v1/images/generations') {
    return handleImageGenerations(request, requestId);
  }

  return createErrorResponse('Not Found', 404, 'not_found');
}

// 处理 Chat 接口 (适配 Cherry Studio / NextChat)
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];
    
    let prompt = "";
    let imageUrls = [];

    // 1. 解析多模态消息 (OpenAI Vision 格式)
    if (Array.isArray(lastMsg.content)) {
      for (const part of lastMsg.content) {
        if (part.type === 'text') prompt += part.text;
        if (part.type === 'image_url') {
          const url = part.image_url.url;
          if (url.startsWith('data:')) {
            // Base64 图片，需要上传
            const fileData = dataURLtoBlob(url);
            // 并发上传所有图片
            const uploadedUrl = await uploadImageToR2(fileData.blob, `upload-${Date.now()}.${fileData.ext}`, fileData.type, request.ctx);
            imageUrls.push(uploadedUrl);
          } else {
            // 普通 URL，直接使用 (PixArmory 支持 R2 链接，如果是外部链接可能需要中转，这里假设客户端传的是可访问链接)
            imageUrls.push(url); 
          }
        }
      }
    } else {
      prompt = lastMsg.content;
    }

    // 2. 兼容性处理：如果 Prompt 是 JSON (WebUI 传参 hack)，尝试解析
    try {
      if (typeof prompt === 'string' && prompt.trim().startsWith('{')) {
        const parsed = JSON.parse(prompt);
        if (parsed.prompt) prompt = parsed.prompt;
        if (parsed.imageUrls && Array.isArray(parsed.imageUrls)) {
            imageUrls = imageUrls.concat(parsed.imageUrls);
        }
      }
    } catch(e) {}

    if (!prompt && imageUrls.length === 0) throw new Error("Prompt 不能为空");

    // 3. 执行生成
    const result = await generateImage(prompt, imageUrls, request.ctx);
    
    // 4. 构造 Markdown 响应
    const content = `![Generated Image](${result.url})\n\n**Prompt:** ${prompt}\n**Credits:** Used ${result.creditsUsed}, Remaining ${result.remainingCredits}`;

    // 5. 模拟流式输出 (为了兼容性)
    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      
      (async () => {
        const chunk = {
          id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
          model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        
        const end = {
          id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
          model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(end)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      })();

      return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream' }) });
    }

    // 6. 非流式响应
    return new Response(JSON.stringify({
      id: requestId, object: 'chat.completion', created: Math.floor(Date.now()/1000),
      model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// 处理 Image 接口 (标准 DALL-E 格式)
async function handleImageGenerations(request, requestId) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    // 图像接口通常只传 prompt，不支持参考图，除非扩展协议
    const result = await generateImage(prompt, [], request.ctx);
    
    return new Response(JSON.stringify({
      created: Math.floor(Date.now()/1000),
      data: [{ url: result.url, revised_prompt: prompt }]
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// 代理上传接口 (供 WebUI 使用)
async function handleProxyUpload(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');
  
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) throw new Error("No file provided");

    const accessUrl = await uploadImageToR2(file, file.name, file.type, request.ctx);
    
    return new Response(JSON.stringify({ success: true, url: accessUrl }), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });
  } catch (e) {
    return createErrorResponse(e.message, 500, 'upload_failed');
  }
}

// --- 辅助函数 ---

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true;
  return auth === `Bearer ${key}`;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// Base64 DataURL 转 Blob
function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return { blob: new Blob([u8arr], { type: mime }), type: mime, ext: mime.split('/')[1] };
}

// --- [第四部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      
      .box { background: #252525; padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 5px; display: block; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 8px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .upload-area { border: 1px dashed #555; border-radius: 4px; padding: 20px; text-align: center; cursor: pointer; transition: 0.2s; background-size: cover; background-position: center; position: relative; min-height: 80px; display: flex; align-items: center; justify-content: center; }
      .upload-area:hover { border-color: var(--primary); background-color: #2a2a2a; }
      .upload-text { font-size: 12px; color: #888; pointer-events: none; z-index: 2; text-shadow: 0 1px 2px black; }
      .preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 5px; margin-top: 10px; }
      .preview-item { width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid #444; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 10px 15px; border-radius: 8px; line-height: 1.5; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; }
      .msg.ai img { max-width: 100%; border-radius: 4px; margin-top: 10px; display: block; cursor: pointer; }
      
      .log-panel { height: 150px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #666; margin-right: 5px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">🎨 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API 密钥</span>
            <div class="code-block" onclick="copy('${request.ctx.apiKey}')">${request.ctx.apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">参考图 (图生图 - 可选多张)</span>
            <input type="file" id="file-input" accept="image/*" multiple style="display:none" onchange="handleFileSelect()">
            <div class="upload-area" id="upload-area" onclick="document.getElementById('file-input').click()">
                <span class="upload-text" id="upload-text">点击上传图片 (支持多选)</span>
            </div>
            <div class="preview-grid" id="preview-grid"></div>

            <span class="label" style="margin-top:10px">提示词</span>
            <textarea id="prompt" rows="4" placeholder="描述你想生成的图片..."></textarea>
            
            <button id="btn-gen" onclick="generate()">开始生成</button>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:50px;">
                PixArmory 代理服务就绪。<br>
                支持匿名模式，每次请求自动轮换指纹。<br>
                支持上传多张参考图进行融合生成。
            </div>
        </div>
        <div class="log-panel" id="logs"></div>
    </main>

    <script>
        const API_KEY = "${request.ctx.apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        const UPLOAD_URL = "${origin}/proxy/upload";
        let uploadedUrls = [];

        function log(msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function copy(text) {
            navigator.clipboard.writeText(text);
            log('已复制到剪贴板');
        }

        async function handleFileSelect() {
            const input = document.getElementById('file-input');
            const files = input.files;
            if (!files.length) return;

            const text = document.getElementById('upload-text');
            const grid = document.getElementById('preview-grid');
            
            text.innerText = "上传中...";
            
            // 清空旧数据
            uploadedUrls = [];
            grid.innerHTML = '';

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const formData = new FormData();
                formData.append('file', file);

                try {
                    log(\`开始上传参考图 \${i+1}/\${files.length}...\`);
                    const res = await fetch(UPLOAD_URL, {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + API_KEY },
                        body: formData
                    });
                    const data = await res.json();
                    if (data.success) {
                        uploadedUrls.push(data.url);
                        log(\`参考图 \${i+1} 上传成功: \${data.url}\`);
                        
                        // 添加预览
                        const img = document.createElement('img');
                        img.src = data.url;
                        img.className = 'preview-item';
                        grid.appendChild(img);
                    } else {
                        log(\`上传失败: \${JSON.stringify(data)}\`);
                    }
                } catch (e) {
                    log(\`上传错误: \${e.message}\`);
                }
            }
            
            if (uploadedUrls.length > 0) {
                text.innerText = \`✅ 已上传 \${uploadedUrls.length} 张图片\`;
                text.style.color = "#66BB6A";
            } else {
                text.innerText = "❌ 上传失败";
                text.style.color = "#CF6679";
            }
        }

        function appendMsg(role, html) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerHTML = html;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt && uploadedUrls.length === 0) return alert('请输入提示词或上传图片');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = "生成中...";

            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            let userHtml = prompt || '[仅参考图]';
            if (uploadedUrls.length > 0) userHtml += \` <span style="font-size:12px;color:#888">[含 \${uploadedUrls.length} 张参考图]</span>\`;
            appendMsg('user', userHtml);
            
            const loadingMsg = appendMsg('ai', '⏳ 正在请求 PixArmory 生成图片 (匿名模式)...');

            try {
                // 构造请求
                let payload = {
                    model: "pixarmory-v1",
                    messages: [{ role: "user", content: prompt }],
                    stream: true
                };

                // 如果有图片，构造多模态消息 (hacky way for WebUI to pass array)
                if (uploadedUrls.length > 0) {
                    payload.messages[0].content = JSON.stringify({
                        prompt: prompt,
                        imageUrls: uploadedUrls
                    });
                }

                log('发送生成请求...');
                log(\`Payload: \${JSON.stringify(payload)}\`);

                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) throw new Error((await res.json()).error?.message || '生成失败');

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullContent = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') break;
                            try {
                                const json = JSON.parse(dataStr);
                                const content = json.choices[0].delta.content;
                                if (content) fullContent += content;
                            } catch (e) {}
                        }
                    }
                }

                // 解析 Markdown 图片
                const match = fullContent.match(/\\((.*?)\\)/);
                if (match) {
                    const imgUrl = match[1];
                    loadingMsg.innerHTML = \`
                        <div><strong>生成成功</strong></div>
                        <img src="\${imgUrl}" onclick="window.open(this.src)">
                        <div style="margin-top:5px"><a href="\${imgUrl}" download style="color:var(--primary)">下载原图</a></div>
                    \`;
                    log('生成成功: ' + imgUrl);
                } else {
                    loadingMsg.innerText = fullContent;
                }

            } catch (e) {
                loadingMsg.innerHTML = \`<span style="color:#CF6679">❌ 错误: \${e.message}</span>\`;
                log('错误: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "开始生成";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
