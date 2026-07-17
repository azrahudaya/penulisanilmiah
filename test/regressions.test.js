import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminderbot-test-'));
process.env.DB_PATH = path.join(tempDir, 'tasks.db');
process.env.TASK_PARSER_PROVIDER = 'rule_based';

const { canMatchRegistrationVoteByChat, findPollOptionName, findSentPollMessage } = await import('../src/poll.js');
const { prepareTasksForInsert } = await import('../src/tasks.js');
const dbModule = await import('../src/db.js');
const { extractTasks } = await import('../src/nlp.js');
const db = dbModule.default;

assert.equal(findPollOptionName({ name: 'Simpan' }), 'simpan');
assert.equal(findPollOptionName({ localId: 2 }, [{ localId: 2, name: 'Setuju' }]), 'setuju');
assert.equal(canMatchRegistrationVoteByChat({ registration_step: 'consent', consent_poll_message_id: '' }), true);
assert.equal(canMatchRegistrationVoteByChat({ registration_step: 'consent', consent_poll_message_id: 'poll-id' }), false);
assert.equal(canMatchRegistrationVoteByChat({ registration_step: 'completed', consent_poll_message_id: '' }), false);
assert.equal(findSentPollMessage([
  { fromMe: true, type: 'chat', body: 'Setuju?' },
  { fromMe: true, type: 'poll_creation', pollName: 'Setuju?', id: 1 },
], 'Setuju?').id, 1);
assert.throws(() => prepareTasksForInsert('chat', [{ title: 'rusak', deadline_iso: 'bukan tanggal' }]), /deadline/);

const beforeRelative = Date.now();
const [relativeTask] = await extractTasks('meeting dalam 30 menit lagi', { source: 'test' });
const relativeDelay = Date.parse(relativeTask.deadline_iso) - beforeRelative;
assert.ok(relativeDelay >= 29 * 60_000 && relativeDelay <= 31 * 60_000, `relative delay: ${relativeDelay}`);

const valid = prepareTasksForInsert('chat', [{ title: 'Tes', deadline_iso: '2030-01-01T10:00:00+07:00' }]);
assert.equal(dbModule.insertTasks(valid).length, 1);
const before = db.prepare('SELECT COUNT(*) total FROM tasks').get().total;
assert.throws(() => dbModule.insertTasks([
  { chatId: 'chat', title: 'A', deadlineMs: Date.now() },
  { chatId: 'chat', title: 'B', deadlineMs: null },
]));
assert.equal(db.prepare('SELECT COUNT(*) total FROM tasks').get().total, before);

const log = dbModule.insertResearchLog({ chatId: 'chat' });
dbModule.upsertPendingConfirmation({ chatId: 'chat', tasks: valid, researchLogId: log.id });
db.prepare('UPDATE pending_confirmations SET created_at = 1 WHERE chat_id = ?').run('chat');
assert.equal(dbModule.deleteExpiredPendingConfirmations(1000, Date.now()), 1);
assert.equal(dbModule.getResearchLog(log.id).confirmation_status, 'expired');

db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('regression checks passed');
