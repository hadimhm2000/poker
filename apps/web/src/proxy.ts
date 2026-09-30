import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { paddleHosts } from "./lib/paddle-hosts";

const intl = createMiddleware(routing);

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV !== "production";
  // Paddle only where it is used: the checkout overlay on the pricing page, and the customer
  // portal a billing-page form redirects to. Hosts of the configured environment only.
  const path = request.nextUrl.pathname;
  const paddle = paddleHosts(process.env.PADDLE_ENV === "production" ? "production" : "sandbox");
  const checkout = /^\/[a-z]{2}\/pricing\/?$/.test(path) && !!process.env.PADDLE_CLIENT_TOKEN;
  const portal = /^\/[a-z]{2}\/account\/billing\/?$/.test(path);
  const csp = [
    "default-src 'self'",
    // Browsers without 'strict-dynamic' fall back to the host list; the nonce still applies.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${checkout ? ` ${paddle.script}` : ""}${isDev ? " 'unsafe-eval'" : ""}`,
    // React sets inline style attributes; nonces cannot cover those.
    `style-src 'self' 'unsafe-inline'${checkout ? ` ${paddle.script}` : ""}`,
    `img-src 'self' data: blob:${checkout ? ` ${paddle.script}` : ""}`,
    "font-src 'self'",
    `connect-src 'self'${checkout ? ` ${paddle.connect}` : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${portal ? ` ${paddle.portal}` : ""}`,
    // Telegram Login Widget iframe; Paddle's checkout overlay.
    `frame-src https://oauth.telegram.org${checkout ? ` ${paddle.frame}` : ""}`,
    // Only Telegram Web may frame us (it shows the Mini App in an iframe).
    "frame-ancestors 'self' https://web.telegram.org",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  request.headers.set("x-nonce", nonce);
  request.headers.set("Content-Security-Policy", csp);
  const response = intl(request) ?? NextResponse.next({ request: { headers: request.headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Everything except API routes, Next internals and files with an extension.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
