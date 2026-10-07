import { count } from 'drizzle-orm';
import type { DB } from './client.ts';
import { qaTemplateItems, qaTemplates } from './schema/index.ts';

type P = 'low' | 'medium' | 'high' | 'critical';
type Item = [title: string, area: string, expected: string, priority?: P];

/** Default QA template library (inserted once; editable afterwards). */
const LIBRARY: { name: string; category: typeof qaTemplates.$inferInsert.category; description: string; items: Item[] }[] = [
  {
    name: 'WordPress QA', category: 'wordpress', description: 'Core checks for any WordPress build.',
    items: [
      ['WordPress core, theme and plugins are up to date', 'Platform', 'No pending updates; versions recorded', 'high'],
      ['No PHP errors/notices with WP_DEBUG enabled on staging', 'Platform', 'Debug log is clean', 'high'],
      ['Admin users reviewed; no default "admin" account', 'Security', 'Only named accounts with least privilege', 'critical'],
      ['Permalinks configured and all menu links resolve', 'Navigation', 'No 404s from navigation'],
      ['Contact/lead forms submit and deliver email', 'Forms', 'Submission recorded and email received', 'critical'],
      ['Media library images have alt text', 'Accessibility', 'Meaningful alt text on content images'],
      ['Caching configured and verified', 'Performance', 'Pages served from cache for anonymous users'],
      ['Backups scheduled and a restore tested', 'Operations', 'Restore succeeded on staging', 'high'],
    ],
  },
  {
    name: 'Elementor QA', category: 'elementor', description: 'Page-builder specific layout and responsiveness checks.',
    items: [
      ['Global colours and fonts used (no hard-coded styles)', 'Design system', 'Site settings drive styles'],
      ['Desktop, tablet and mobile breakpoints reviewed on every template', 'Responsive', 'No overflow, overlap or hidden content', 'high'],
      ['Header/footer templates applied with correct display conditions', 'Templates', 'Correct template on every page type'],
      ['Popups trigger correctly and can be closed by keyboard', 'Interaction', 'Popup triggers & ESC close work'],
      ['Unused widgets/sections removed; CSS print method set to external', 'Performance', 'No unused assets loaded'],
      ['Motion effects respect reduced-motion preference', 'Accessibility', 'Animations disabled with prefers-reduced-motion'],
    ],
  },
  {
    name: 'WooCommerce QA', category: 'woocommerce', description: 'Store, checkout and order lifecycle.',
    items: [
      ['Add to cart for simple, variable and out-of-stock products', 'Catalog', 'Correct behaviour per product type', 'high'],
      ['Cart totals, coupons and shipping zones calculate correctly', 'Cart', 'Totals match expected values', 'critical'],
      ['Checkout completes with each enabled payment gateway (test mode)', 'Checkout', 'Order created with correct status', 'critical'],
      ['Taxes calculated per configured rules', 'Checkout', 'Tax lines match rules', 'high'],
      ['Order emails (customer & admin) are sent and branded', 'Emails', 'All transactional emails received'],
      ['Refund and cancellation flow updates stock', 'Orders', 'Stock and order status correct after refund'],
      ['Account area: orders, addresses, password reset', 'Account', 'All account features work'],
    ],
  },
  {
    name: 'Mobile app QA', category: 'mobile_app', description: 'iOS/Android app release checks.',
    items: [
      ['Install, launch and upgrade from previous version', 'Lifecycle', 'No crashes; data migrated', 'critical'],
      ['Permissions requested in context with clear copy', 'Privacy', 'Denied permissions handled gracefully', 'high'],
      ['Offline and poor-network behaviour', 'Network', 'Clear error states; no data loss', 'high'],
      ['Push notifications received and deep-link correctly', 'Notifications', 'Opens the right screen'],
      ['Dynamic type / font scaling and screen reader labels', 'Accessibility', 'Usable at largest text size'],
      ['Tested on minimum supported OS versions and small screens', 'Compatibility', 'No layout breakage', 'high'],
    ],
  },
  {
    name: 'SEO QA', category: 'seo', description: 'On-page and technical SEO before launch.',
    items: [
      ['Unique title and meta description on every indexable page', 'On-page', 'No duplicates or missing tags', 'high'],
      ['One H1 per page; logical heading order', 'On-page', 'Headings are hierarchical'],
      ['XML sitemap generated and robots.txt allows indexing (production)', 'Technical', 'Sitemap valid; robots correct', 'critical'],
      ['Canonical tags present and correct', 'Technical', 'Self-referencing canonicals'],
      ['301 redirects from old URLs mapped and tested', 'Migration', 'No broken legacy URLs', 'high'],
      ['Structured data validates (Organisation, Breadcrumb, Product…)', 'Technical', 'No schema errors'],
      ['Analytics and Search Console connected', 'Tracking', 'Data flowing'],
    ],
  },
  {
    name: 'Performance QA', category: 'performance', description: 'Core Web Vitals and asset budgets.',
    items: [
      ['LCP < 2.5s on mobile (field or lab) for key templates', 'Core Web Vitals', 'Passes on home, listing and detail pages', 'high'],
      ['CLS < 0.1; images and embeds have dimensions', 'Core Web Vitals', 'No visible layout shift', 'high'],
      ['INP < 200ms for primary interactions', 'Core Web Vitals', 'Responsive interactions'],
      ['Images served in modern formats and lazy-loaded below the fold', 'Assets', 'WebP/AVIF, lazy loading'],
      ['No render-blocking third-party scripts', 'Assets', 'Scripts deferred/async'],
      ['Compression and caching headers set on static assets', 'Server', 'gzip/br + long cache TTL'],
    ],
  },
  {
    name: 'Security QA', category: 'security', description: 'OWASP-informed checks before go-live.',
    items: [
      ['HTTPS everywhere with HSTS; no mixed content', 'Transport', 'All requests over TLS', 'critical'],
      ['Security headers (CSP, X-Content-Type-Options, frame-ancestors)', 'Headers', 'Headers present and correct', 'high'],
      ['Authentication: lockout/rate limiting and secure password reset', 'Auth', 'Brute force mitigated', 'critical'],
      ['Authorization: users cannot access others’ records (IDOR)', 'Access control', 'Out-of-scope IDs rejected', 'critical'],
      ['File uploads restricted by type/size and not executable', 'Uploads', 'Malicious files rejected', 'high'],
      ['No secrets in repository, client bundle or logs', 'Secrets', 'Secret scan clean', 'critical'],
      ['Dependencies scanned for known vulnerabilities', 'Dependencies', 'No high/critical advisories', 'high'],
    ],
  },
  {
    name: 'Pre-launch QA', category: 'pre_launch', description: 'Final go-live checklist.',
    items: [
      ['Client has approved final content and design', 'Sign-off', 'Written approval on record', 'critical'],
      ['Production environment configured (env vars, cron, email, backups)', 'Operations', 'Configuration verified', 'critical'],
      ['DNS, SSL and domain redirects (www/non-www) ready', 'Infrastructure', 'Cut-over plan tested', 'high'],
      ['Staging/test content and test accounts removed', 'Content', 'No placeholder or test data', 'high'],
      ['Search engine indexing enabled on production', 'SEO', 'noindex removed', 'critical'],
      ['Monitoring/uptime alerts and error tracking active', 'Operations', 'Alerts reach the team'],
      ['Rollback plan documented', 'Operations', 'Rollback steps verified'],
      ['Cross-browser smoke test (Chrome, Safari, Firefox, Edge)', 'Compatibility', 'Key journeys pass', 'high'],
    ],
  },
];

export async function seedQaTemplates(db: DB) {
  const [{ n }] = await db.select({ n: count() }).from(qaTemplates);
  if (Number(n) > 0) return;
  for (const t of LIBRARY) {
    const [tpl] = await db.insert(qaTemplates).values({ name: t.name, category: t.category, description: t.description }).returning();
    await db.insert(qaTemplateItems).values(t.items.map(([title, area, expectedResult, priority], i) => ({
      templateId: tpl.id, title, area, expectedResult, priority: priority ?? 'medium', sortOrder: i,
    })));
  }
}
