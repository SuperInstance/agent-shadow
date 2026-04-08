interface ShadowRequest {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  source: 'production' | 'shadow';
}

interface DiffResult {
  id: string;
  timestamp: number;
  production: {
    status: number;
    headers: Record<string, string>;
    body: string;
    latency: number;
  };
  shadow: {
    status: number;
    headers: Record<string, string>;
    body: string;
    latency: number;
  };
  differences: {
    status: boolean;
    headers: string[];
    body: {
      lengthDiff: number;
      similarity: number;
    };
    latency: number;
  };
}

interface ShadowConfig {
  enabled: boolean;
  target: string;
  sampleRate: number;
  diffThreshold: number;
  canaryWeight: number;
}

const SHADOW_CONFIG: ShadowConfig = {
  enabled: true,
  target: "https://shadow.example.com",
  sampleRate: 0.1,
  diffThreshold: 0.95,
  canaryWeight: 0.05
};

const SHADOW_STORAGE: KVNamespace = SHADOW as KVNamespace;

async function handleShadowRequest(request: Request): Promise<Response> {
  const shadowReq: ShadowRequest = await request.json();
  
  if (!SHADOW_CONFIG.enabled || Math.random() > SHADOW_CONFIG.sampleRate) {
    return new Response(JSON.stringify({ status: "skipped" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const shadowResponse = await fetch(SHADOW_CONFIG.target, {
    method: shadowReq.method,
    headers: shadowReq.headers,
    body: shadowReq.body
  });

  const diffId = `diff:${Date.now()}:${shadowReq.id}`;
  await SHADOW_STORAGE.put(diffId, JSON.stringify({
    shadowRequest: shadowReq,
    shadowResponse: {
      status: shadowResponse.status,
      headers: Object.fromEntries(shadowResponse.headers.entries()),
      body: await shadowResponse.text(),
      latency: 0
    }
  }), { expirationTtl: 86400 });

  return new Response(JSON.stringify({ 
    status: "mirrored", 
    diffId 
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleDiffRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const diffId = url.searchParams.get("id");
  
  if (!diffId) {
    return new Response(JSON.stringify({ error: "Missing diff ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const diffData = await SHADOW_STORAGE.get(diffId, "json");
  if (!diffData) {
    return new Response(JSON.stringify({ error: "Diff not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const diffResult: DiffResult = {
    id: diffId,
    timestamp: Date.now(),
    production: diffData.production || { status: 0, headers: {}, body: "", latency: 0 },
    shadow: diffData.shadowResponse,
    differences: {
      status: diffData.production?.status !== diffData.shadowResponse.status,
      headers: [],
      body: {
        lengthDiff: Math.abs(
          (diffData.production?.body?.length || 0) - 
          (diffData.shadowResponse.body?.length || 0)
        ),
        similarity: calculateSimilarity(
          diffData.production?.body || "",
          diffData.shadowResponse.body || ""
        )
      },
      latency: Math.abs(
        (diffData.production?.latency || 0) - 
        (diffData.shadowResponse.latency || 0)
      )
    }
  };

  return new Response(JSON.stringify(diffResult), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handlePromoteRequest(request: Request): Promise<Response> {
  const { canaryId, weight = SHADOW_CONFIG.canaryWeight } = await request.json();
  
  if (!canaryId) {
    return new Response(JSON.stringify({ error: "Missing canary ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const canaryData = await SHADOW_STORAGE.get(`canary:${canaryId}`, "json");
  if (!canaryData) {
    return new Response(JSON.stringify({ error: "Canary not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const successRate = canaryData.successRate || 0;
  const errorRate = canaryData.errorRate || 0;
  
  if (errorRate > 0.01 || successRate < SHADOW_CONFIG.diffThreshold) {
    return new Response(JSON.stringify({ 
      status: "rejected",
      reason: "Quality thresholds not met",
      metrics: { successRate, errorRate }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  await SHADOW_STORAGE.put("active_canary", JSON.stringify({
    id: canaryId,
    weight,
    promotedAt: Date.now()
  }));

  return new Response(JSON.stringify({ 
    status: "promoted",
    canaryId,
    weight
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  
  const maxLength = Math.max(str1.length, str2.length);
  const distance = levenshteinDistance(str1, str2);
  return 1 - distance / maxLength;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  
  return matrix[b.length][a.length];
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  
  const headers = {
    "Content-Type": "application/json",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'"
  };
  
  if (path === "/health") {
    return new Response(JSON.stringify({ 
      status: "healthy",
      service: "agent-shadow",
      timestamp: Date.now()
    }), { status: 200, headers });
  }
  
  if (path === "/api/shadow" && request.method === "POST") {
    return handleShadowRequest(request);
  }
  
  if (path === "/api/diff" && request.method === "GET") {
    return handleDiffRequest(request);
  }
  
  if (path === "/api/promote" && request.method === "POST") {
    return handlePromoteRequest(request);
  }
  
  return new Response(JSON.stringify({ 
    error: "Not found",
    endpoints: ["POST /api/shadow", "GET /api/diff", "POST /api/promote", "GET /health"]
  }), { status: 404, headers });
}

export default {
  async fetch(request: Request, env: { SHADOW: KVNamespace }): Promise<Response> {
    SHADOW = env.SHADOW;
    return handleRequest(request);
  }
};
