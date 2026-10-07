import { eq } from 'drizzle-orm';
import { kbArticles } from '../../db/schema/index.ts';
import { defineResource } from '../registry.ts';

/**
 * Article metadata for editors (list, filters, export, comments on drafts). Reading, versioned
 * content, publishing and acknowledgements go through /api/kb (modules/kb.ts).
 */
defineResource({
  key: 'kb_articles', table: kbArticles, label: 'Article', plural: 'Knowledge base', module: 'knowledge', perm: 'kb',
  permissions: { view: 'kb.create', create: null, edit: 'kb.edit', delete: 'kb.delete' },
  titleField: 'title', defaultSort: 'title', collab: { comments: true, files: true },
  scopes: { own: (a) => eq(kbArticles.ownerId, a.userId) },
  fields: {
    title: { type: 'text', label: 'Title', readonly: true, list: true, search: true },
    category: { type: 'enum', label: 'Category', options: ['sop', 'policy', 'dev_standard', 'qa_standard', 'pm_procedure', 'sales_procedure', 'hr_policy', 'template', 'training', 'architecture', 'other'], list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['draft', 'published', 'archived'], list: true, filter: true },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true },
    requiredReading: { type: 'bool', label: 'Required reading', list: true, filter: true },
    acknowledgeWithinDays: { type: 'int', label: 'Acknowledge within (days)', min: 1, max: 90 },
    reviewIntervalDays: { type: 'int', label: 'Review every (days)', min: 7, max: 1095 },
    lastReviewedOn: { type: 'date', label: 'Last reviewed', list: true },
    publishedAt: { type: 'datetime', label: 'Published', readonly: true, list: true },
    summary: { type: 'textarea', label: 'Summary' },
  },
});
