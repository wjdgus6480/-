import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getMeta, openDotdayDB, setMeta, type DB } from '../db/idb';
import { SupabaseDomainRemote, type DomainRemote } from '../domain/remote';
import { DomainRepository } from '../domain/repo';
import { DomainSyncEngine } from '../domain/sync';
import { uuid } from '../lib/util';
import { SupabaseViewRemote, type ViewRemote } from '../views/remote';
import { ViewRepository } from '../views/repo';
import { ViewSyncEngine } from '../views/sync';

export interface Services {
  db: DB;
  domain: DomainRepository;
  views: ViewRepository;
  /** 보기 설정 동기화 */
  sync: ViewSyncEngine;
  /** 업무 데이터 동기화 (보기 설정과 별개) */
  domainSync: DomainSyncEngine;
  session: { owner: string | null; email: string | null; ownerId(): string | null; localProfileId: string };
  supabase: SupabaseClient | null;
  remote: ViewRemote | null;
  domainRemote: DomainRemote | null;
}

export async function createServices(dbName = 'dotday'): Promise<Services> {
  const db = await openDotdayDB(dbName);
  let profile = await getMeta<string>(db, 'local_profile_id');
  if (!profile) {
    profile = uuid();
    await setMeta(db, 'local_profile_id', profile);
  }
  const session = {
    owner: null as string | null,
    email: null as string | null,
    ownerId() {
      return this.owner;
    },
    localProfileId: profile,
  };
  // 브라우저에는 anon(publishable) 키만 둔다. service_role 키는 절대 넣지 않는다.
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const supabase = url && key ? createClient(url, key) : null;
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    session.owner = data.session?.user.id ?? null;
    session.email = data.session?.user.email ?? null;
  }
  const remote = supabase ? new SupabaseViewRemote(supabase, () => session.owner) : null;
  const domainRemote = supabase ? new SupabaseDomainRemote(supabase, () => session.owner) : null;
  const domain = new DomainRepository(db, () => session.owner);
  const views = new ViewRepository(db, session, domain);
  const sync = new ViewSyncEngine(db, views, () => remote);
  const domainSync = new DomainSyncEngine(db, domain, () => domainRemote);
  return { db, domain, views, sync, domainSync, session, supabase, remote, domainRemote };
}
