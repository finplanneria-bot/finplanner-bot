// Intercepts WhatsApp sends — captures message body to stdout
const capturedMessages = [];

const post = async (url, data, config) => {
  if (typeof url === "string" && url.includes("graph.facebook.com")) {
    const bodyStr = JSON.stringify(data);
    console.log("[WA-CAPTURED]", JSON.stringify({ path: url.split("graph.facebook.com")[1] || url, body: data }).slice(0, 700));
    return { data: { messages: [{ id: "wamid.mock_" + Date.now() }] }, status: 200 };
  }
  if (typeof url === "string" && url.includes("googleapis.com")) {
    return { data: { values: [], range: "A:Z" }, status: 200 };
  }
  // Real HTTP for OpenAI calls
  const https = await import("https");
  const http = await import("http");
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(data);
    const opts = {
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(config?.headers || {}) },
    };
    const req = (parsed.protocol === "https:" ? https : http).default.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { resolve({ data: JSON.parse(d), status: res.statusCode }); } catch { resolve({ data: d, status: res.statusCode }); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
};

const get = async (url, config) => {
  if (typeof url === "string" && (url.includes("graph.facebook.com") || url.includes("googleapis.com"))) {
    return { data: { values: [], range: "A:Z" }, status: 200 };
  }
  return { data: {}, status: 200 };
};

const axiosMock = { post, get, create: () => axiosMock, defaults: { headers: { common: {}, post: {}, get: {} } }, interceptors: { request: { use: () => 0 }, response: { use: () => 0 } } };
export default axiosMock;
export { post, get };
