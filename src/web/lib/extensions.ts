import type { ComponentType } from 'react';

/** Bespoke panels shown on a resource's detail page (e.g. invoice line items, QA run execution). */
export interface DetailPanel {
  key: string;
  label: string;
  component: ComponentType<{ record: any; reload: () => void }>;
  /** Render above the tabs instead of as a tab. */
  placement?: 'top' | 'tab';
}

/** Bespoke header actions (workflow buttons) for a resource's detail page. */
export type DetailActions = ComponentType<{ record: any; reload: () => void }>;

const panels = new Map<string, DetailPanel[]>();
const actions = new Map<string, DetailActions>();

export function registerPanel(resource: string, panel: DetailPanel) {
  panels.set(resource, [...(panels.get(resource) ?? []), panel]);
}
export function registerActions(resource: string, comp: DetailActions) {
  actions.set(resource, comp);
}
export const panelsFor = (resource: string) => panels.get(resource) ?? [];
export const actionsFor = (resource: string) => actions.get(resource);
