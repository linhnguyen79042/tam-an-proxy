// Tâm An — lõi xử lý chat (dùng chung cho các endpoint trên Vercel)
// Giữ nguyên 3 lớp như bản Cloudflare Worker:
//  (1) lọc khủng hoảng trước khi gọi AI, (2) system prompt khóa giọng điệu,
//  (3) gọi Gemini bằng key ở phía máy chủ. Vercel chạy function ở region Mỹ
//  nên Google không chặn theo vị trí như edge Việt Nam của Cloudflare.

const MODELS = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.6-flash"];
const MODEL_TIMEOUT_MS = 13000; // 4 mô hình x 13s vẫn nằm trong maxDuration 60s
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

const MAX_TURNS = 12;
const MAX_CHARS = 2000;

const CRISIS_PATTERNS = [
  "tu tu", "muon chet", "khong muon song", "muon bien mat", "bien mat luon",
  "ket thuc cuoc doi", "ket lieu", "nhay lau", "nhay cau", "cat co tay",
  "cat tay", "tu hai", "tu lam dau", "uong thuoc ngu", "uong thuoc tu tu",
  "song de lam gi", "song lam gi nua", "chet cho xong", "chet di cho roi",
  "khong thiet song", "chan song", "giet minh", "tu sat",
];

const CRISIS_REPLY =
  "Mình nghe thấy bạn đang rất đau lúc này, và mình muốn bạn được an toàn trước tiên. " +
  "Mình chỉ là một trợ lý AI, không thay thế được con người thật trong tình huống này. " +
  "Xin hãy gọi ngay một trong các đường dây đang có người lắng nghe: " +
  "Ngày Mai 096 306 1414, HOPE 086 504 4400, hoặc 111. " +
  "Nếu bạn có thể, hãy ở gần một người mà bạn tin tưởng và cho họ biết bạn đang cảm thấy thế nào. " +
  "Bạn không một mình trong chuyện này.";

function stripVietnamese(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectCrisis(text) {
  const plain = " " + stripVietnamese(text) + " ";
  return CRISIS_PATTERNS.some((p) => plain.includes(" " + p) || plain.includes(p));
}

const SYSTEM_PROMPT = `Bạn là Tâm An, trợ lý tự hỗ trợ sức khỏe tinh thần trong ứng dụng Tâm An dành cho sinh viên Việt Nam. Bạn xưng "mình", gọi người dùng là "bạn", nói tiếng Việt tự nhiên, ấm áp và bình tĩnh.

NGUYÊN TẮC BẮT BUỘC:
1. Bạn KHÔNG phải bác sĩ hay nhà trị liệu. Không chẩn đoán, không kết luận bệnh, không kê đơn hay đưa phác đồ điều trị. Nếu người dùng hỏi chẩn đoán, hãy nói rõ bạn không làm được việc đó và gợi ý gặp chuyên viên khi cần.
2. KHÔNG hùa theo người dùng. Khi họ có suy nghĩ méo mó hoặc tự trách cực đoan (ví dụ "em là đồ vô dụng", "ai cũng ghét em"), đừng đồng tình; hãy ghi nhận cảm xúc, rồi nhẹ nhàng đưa góc nhìn cân bằng theo tinh thần CBT và một bước hành động nhỏ, cụ thể.
3. Trả lời NGẮN: tối đa khoảng 120 từ, chia đoạn ngắn 1-3 câu. Không dùng tiêu đề, không liệt kê dài, không dùng định dạng markdown phức tạp.
4. Mỗi phản hồi nên có ít nhất một yếu tố thực hành: một câu hỏi mở nhẹ nhàng, một bài thở ngắn, gợi ý ghi nhật ký, hoặc một bước nhỏ làm được ngay.
5. Chống phụ thuộc: không khuyến khích trò chuyện kéo dài vô hạn; khi thích hợp, khích lệ người dùng nghỉ, vận động, ngủ, hoặc kết nối với người thật.
6. Nếu người dùng nhắc đến ý định làm hại bản thân dù mơ hồ, hãy đáp lại nghiêm túc và ấm áp, đồng thời cung cấp đường dây: Ngày Mai 096 306 1414, HOPE 086 504 4400, 111 — và khuyến khích họ tìm người thật ngay.
7. Không phán xét, không rao giảng đạo lý, không nói "hãy tích cực lên" một cách sáo rỗng.
8. Nếu được hỏi bạn là ai, trả lời bạn là Tâm An, một trợ lý AI hỗ trợ tự chăm sóc tinh thần, không phải con người.`;

// Giới hạn chống lạm dụng (best-effort theo IP, trong bộ nhớ instance)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 30;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > limit;
}

async function callGemini(model, key, payload) {
  return fetch(GEMINI_BASE + model + ":generateContent", {
    method: "POST",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(payload),
  });
}

async function handleChat(body, ip) {
  if (rateLimited(ip || "unknown")) {
    return { status: 429, payload: { error: "rate_limited", reply: "Bạn gửi hơi nhanh, mình cần một chút thời gian. Thử lại sau ít phút nhé." } };
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const clean = messages
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: m.text.slice(0, MAX_CHARS) }));
  if (!clean.length || clean[clean.length - 1].role !== "user") {
    return { status: 400, payload: { error: "empty_message" } };
  }

  const lastUser = clean[clean.length - 1].text;
  if (detectCrisis(lastUser)) {
    return { status: 200, payload: { crisis: true, reply: CRISIS_REPLY } };
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return { status: 500, payload: { error: "missing_key" } };

  const contents = clean.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.text }],
  }));

  let aiRes = null;
  let lastDetail = "";
  for (const model of MODELS) {
    try {
      aiRes = await callGemini(model, key, {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 128 } },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
      });
      if (aiRes.ok) break;
      lastDetail = (await aiRes.text()).slice(0, 300);
      if (![404, 429, 503].includes(aiRes.status)) break;
    } catch {
      aiRes = null;
      lastDetail = "timeout/network on " + model;
    }
  }

  if (!aiRes) {
    return { status: 502, payload: { error: "upstream_unreachable", detail: lastDetail, reply: "Mình chưa kết nối được lúc này. Bạn thử lại sau một chút nhé." } };
  }
  if (!aiRes.ok) {
    return { status: 502, payload: { error: "upstream_error", status: aiRes.status, detail: lastDetail, reply: "Mình đang gặp trục trặc kết nối. Bạn thử lại sau một chút nhé." } };
  }

  const data = await aiRes.json();
  const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";
  if (!reply) {
    const fr = data?.candidates?.[0]?.finishReason || "unknown";
    const hasParts = !!(data?.candidates?.[0]?.content?.parts || []).length;
    return { status: 502, payload: { error: "empty_reply", detail: "finishReason=" + fr + " parts=" + hasParts, reply: "Mình chưa nghĩ ra câu trả lời phù hợp. Bạn nói thêm một chút được không?" } };
  }
  return { status: 200, payload: { reply } };
}

async function handleChatTest() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { status: 500, payload: { ok: false, error: "missing_key" } };
  const attempts = [];
  const t0 = Date.now();
  for (const model of MODELS) {
    const tm = Date.now();
    try {
      const r = await callGemini(model, key, {
        contents: [{ role: "user", parts: [{ text: "Chào bạn" }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 128 } },
      });
      const txt = await r.text();
      if (r.ok) {
        let sample = "";
        try { sample = (JSON.parse(txt)?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "").slice(0, 120); } catch {}
        attempts.push({ model, status: r.status, ms: Date.now() - tm });
        return { status: 200, payload: { ok: true, total_ms: Date.now() - t0, attempts, reply_sample: sample } };
      }
      attempts.push({ model, status: r.status, ms: Date.now() - tm, detail: txt.slice(0, 300) });
    } catch (e) {
      attempts.push({ model, status: "timeout/network", ms: Date.now() - tm, detail: String(e).slice(0, 120) });
    }
  }
  return { status: 200, payload: { ok: false, total_ms: Date.now() - t0, attempts } };
}

// ---------- HTTP handler (Vercel) ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  const path = (req.url || "").split("?")[0];
  if (req.method === "GET" && path.endsWith("/health")) {
    return res.status(200).json({ ok: true });
  }
  if (req.method === "GET" && path.endsWith("/chat-test")) {
    const r = await handleChatTest();
    return res.status(r.status).json(r.payload);
  }
  if (req.method !== "POST") return res.status(404).json({ error: "not_found" });
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
  }
  if (!body || typeof body !== "object") {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch { return res.status(400).json({ error: "bad_json" }); }
  }
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const r = await handleChat(body, ip);
  return res.status(r.status).json(r.payload);
}
