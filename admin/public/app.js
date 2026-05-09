document.addEventListener('click', (event) => {
  const addButton = event.target.closest('[data-add-task]');
  if (addButton) {
    const list = document.querySelector('[data-task-list]');
    const row = document.createElement('div');
    row.className = 'task-row';
    row.innerHTML = `
      <input name="task_title" placeholder="Judul" required>
      <input name="task_date" placeholder="YYYY-MM-DD" required>
      <input name="task_time" placeholder="HH:mm" required>
      <button type="button" class="ghost" data-remove-task>Hapus</button>
    `;
    list.appendChild(row);
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

    if (Array.isArray(data.tasks) && data.tasks.length) {
      const list = document.querySelector('[data-task-list]');
      list.innerHTML = '';
      data.tasks.forEach((task) => {
        const row = document.createElement('div');
        row.className = 'task-row';
        row.innerHTML = `
          <input name="task_title" placeholder="Judul" value="${escHtml(task.title || '')}" required>
          <input name="task_date" placeholder="YYYY-MM-DD" value="${escHtml(task.date || '')}" required>
          <input name="task_time" placeholder="HH:mm" value="${escHtml(task.time || '')}" required>
          <button type="button" class="ghost" data-remove-task>Hapus</button>
        `;
        list.appendChild(row);
      });
    }
  } catch (err) {
    alert('Auto-fill AI gagal: ' + err.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
