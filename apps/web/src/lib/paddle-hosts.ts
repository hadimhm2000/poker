// Paddle hosts per environment. Separate from paddle.ts so the proxy (CSP) stays light.

export type PaddleEnv = "sandbox" | "production";

/** Hosts Paddle needs: Paddle.js script and styles, checkout frame, its API calls, portal, REST API. */
export function paddleHosts(env: PaddleEnv) {
  const p = env === "sandbox" ? "sandbox-" : "";
  return {
    script: "https://cdn.paddle.com",
    frame: `https://${p}buy.paddle.com`,
    connect: `https://${p}checkout-service.paddle.com`,
    portal: `https://${p}customer-portal.paddle.com`,
    api: `https://${p}api.paddle.com`,
  };
}
