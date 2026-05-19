document.addEventListener('click', (event) => {
  const addButton = event.target.closest('[data-add-task]');
  if (addButton) {
    const list = document.querySelector('[data-task-list]');
    if (list) list.appendChild(createTaskRow());
  }

  const removeButton = event.target.closest('[data-remove-task]');
  if (removeButton) {
    const rows = document.querySelectorAll('.task-row');
    if (rows.length > 1) removeButton.closest('.task-row').remove();
  }

  const aiButton = event.target.closest('[data-ai-suggest]');
  if (aiButton) {
    handleAiSuggest(aiButton);
  }
});

async function handleAiSuggest(button) {
  const logId = button.dataset.logId;
  const csrfToken = document.querySelector('[name="csrf_token"]')?.value || '';

  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Memproses...';

  try {
    const resp = await fetch(`/review/${logId}/ai-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `csrf_token=${encodeURIComponent(csrfToken)}`,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Gagal');

    const gtTextarea = document.querySelector('[name="transcript_ground_truth"]');
    if (gtTextarea) gtTextarea.value = data.transcriptGroundTruth || '';

    const tasks = Array.isArray(data.tasks) ? data.tasks.map(normalizeTask).filter((task) => task.title || task.date || task.time) : [];
    if (tasks.length) {
      const list = document.querySelector('[data-task-list]');
      if (list) {
        list.replaceChildren(...tasks.map((task) => createTaskRow(task)));
      }
    }
  } catch (err) {
    alert('Auto-fill AI gagal: ' + err.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function createTaskRow(task = {}) {
  const row = document.createElement('div');
  row.className = 'task-row';

  const title = document.createElement('input');
  title.name = 'task_title';
  title.placeholder = 'Judul';
  title.required = true;
  title.value = task.title || '';

  const date = document.createElement('input');
  date.type = 'date';
  date.name = 'task_date';
  date.required = true;
  date.value = task.date || '';

  const time = document.createElement('input');
  time.type = 'time';
  time.name = 'task_time';
  time.required = true;
  time.value = task.time || '';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost';
  remove.dataset.removeTask = '';
  remove.textContent = 'Hapus';

  row.append(title, date, time, remove);
  return row;
}

function normalizeTask(task) {
  const deadline = String(task.deadline_iso || task.deadline || '');
  const deadlineMatch = deadline.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  return {
    title: String(task.title || task.name || '').trim(),
    date: String(task.date || deadlineMatch?.[1] || '').trim(),
    time: String(task.time || deadlineMatch?.[2] || '').trim().slice(0, 5),
  };
}
