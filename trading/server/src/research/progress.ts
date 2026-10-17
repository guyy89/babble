import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

// Research progress for the progress page: computed from the dataset on disk plus a status file
// (data/research-sip/progress.json) that is updated as research agents start and finish.

const DIR = resolve(config.dataDir, 'research-sip');
const EXPECTED_DAYS = 128;

interface AgentStatus {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done';
  passed?: boolean;
  note?: string;
}

interface StatusFile {
  agents: AgentStatus[];
  audit: 'pending' | 'running' | 'done';
  report: 'pending' | 'running' | 'done';
}

const pctOf = (s: 'pending' | 'running' | 'done') => (s === 'done' ? 100 : s === 'running' ? 50 : 0);

export function researchProgress() {
  const daysDir = resolve(DIR, 'days');
  const days = existsSync(daysDir) ? readdirSync(daysDir).length : 0;
  const quality = existsSync(resolve(DIR, 'quality.json'));
  const file = resolve(DIR, 'progress.json');
  const st: StatusFile = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { agents: [], audit: 'pending', report: 'pending' };

  const done = st.agents.filter((a) => a.status === 'done').length;
  const running = st.agents.filter((a) => a.status === 'running').length;
  const agentsPct = st.agents.length ? ((done + running * 0.4) / st.agents.length) * 100 : 0;
  const stages = [
    { id: 'download', label: 'הורדת נתונים מלאים (6 חודשים)', pct: Math.min(100, (days / EXPECTED_DAYS) * 100), detail: `${days} / ${EXPECTED_DAYS} ימי מסחר` },
    { id: 'quality', label: 'בדיקת שלמות הנתונים', pct: quality ? 100 : 0, detail: quality ? 'הושלמה' : 'ממתינה' },
    { id: 'agents', label: 'סוכני המחקר', pct: agentsPct, detail: `${done} סיימו · ${running} עובדים · ${st.agents.length - done - running} ממתינים` },
    { id: 'audit', label: 'סוכן ביקורת', pct: pctOf(st.audit), detail: st.audit === 'done' ? 'הושלם' : st.audit === 'running' ? 'עובד' : 'ממתין' },
    { id: 'report', label: 'דוח מסכם', pct: pctOf(st.report), detail: st.report === 'done' ? 'מוכן' : st.report === 'running' ? 'בכתיבה' : 'ממתין' },
  ];
  // Weights reflect the expected share of the total time.
  const weights = { download: 10, quality: 2, agents: 78, audit: 6, report: 4 } as Record<string, number>;
  const overall = stages.reduce((a, s) => a + s.pct * weights[s.id], 0) / 100;
  return {
    updatedAt: Date.now(),
    overall: Math.round(overall * 10) / 10,
    stages: stages.map((s) => ({ ...s, pct: Math.round(s.pct * 10) / 10 })),
    agents: st.agents,
    passed: st.agents.filter((a) => a.passed).length,
  };
}
