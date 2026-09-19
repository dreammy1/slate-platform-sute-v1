/**
 * The admin app's Next.js configuration (SLATE-300, ADR 008).
 *
 * `transpilePackages` is required because the workspace packages are consumed as
 * TypeScript *source* (their `exports` point at `src/index.ts`), and the ESLint
 * boundary rules keep the app away from server packages except in the two
 * designated server zones: the API mount (`src/app/api/v1`) and its wiring
 * (`src/server`). Lint is owned by the repository root (`npm run lint`); Next.js
 * no longer accepts an `eslint` key here (v16 removed it), so none is set.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@slate/ui', '@slate/api-client'],
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        {
          // The app-boundary CSP (ADR 008 §2). Styles allow inline because Next
          // injects them; scripts stay first-party only.
          key: 'Content-Security-Policy',
          value:
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
            "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    },
  ],
};

export default nextConfig;
