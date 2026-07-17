export function prepareTasksForInsert(chatId, tasks) {
  if (!chatId || !Array.isArray(tasks) || !tasks.length) throw new Error('Reminder tidak valid. Kirim ulang ya.');
  return tasks.map((task) => {
    const title = String(task?.title || '').trim();
    const deadlineMs = Date.parse(task?.deadline_iso);
    if (!title || !Number.isFinite(deadlineMs)) throw new Error('Judul atau deadline reminder tidak valid. Kirim ulang ya.');
    return { chatId, title, deadlineMs };
  });
}
