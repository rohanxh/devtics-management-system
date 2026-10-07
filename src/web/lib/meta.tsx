import { createContext, useContext } from 'react';

export interface FieldMeta {
  type: string;
  label: string;
  required: boolean;
  readonly: boolean;
  createOnly: boolean;
  options?: string[];
  ref?: string;
  pipeline?: string;
  list: boolean;
  filter: boolean;
  help?: string;
  hidden: boolean;
  group?: string;
  min?: number;
  max?: number;
}

export interface ResourceMeta {
  key: string;
  label: string;
  plural: string;
  module: string;
  description?: string;
  titleField: string;
  fields: Record<string, FieldMeta>;
  defaultSort: string;
  status?: { field: string; transitions?: Record<string, string[]> };
  numberField?: string;
  assignees?: string[];
  board?: string;
  children?: { resource: string; field: string; label?: string }[];
  collab?: { comments?: boolean; files?: boolean };
  viewScope?: 'own' | 'team' | 'all' | null;
  can: { view: boolean; create: boolean; edit: boolean; delete: boolean; export: boolean };
}

export interface Stage { id: string; pipeline: string; key: string; name: string; color: string; sortOrder: number; isTerminal: boolean; outcome: string | null }

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  homeDashboard: string;
  employeeId: string | null;
  mustChangePassword: boolean;
  permissions: Record<string, 'own' | 'team' | 'all'>;
}

export interface Meta {
  user: CurrentUser;
  resources: Record<string, ResourceMeta>;
  pipelines: Record<string, Stage[]>;
  settings: { companyName: string; baseCurrency: string; workdayHours: number };
}

export const MetaContext = createContext<Meta | null>(null);

export function useMeta(): Meta {
  const m = useContext(MetaContext);
  if (!m) throw new Error('Meta not loaded');
  return m;
}

export const useCan = () => {
  const m = useMeta();
  return (perm: string) => perm in m.user.permissions;
};

export function useResource(key: string): ResourceMeta | undefined {
  return useMeta().resources[key];
}

export function useStage(id: string | null | undefined) {
  const m = useMeta();
  if (!id) return undefined;
  for (const list of Object.values(m.pipelines)) {
    const s = list.find((x) => x.id === id);
    if (s) return s;
  }
  return undefined;
}
