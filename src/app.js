// Power Predict — entry point. Wires up the archive-drop UI and the
// predict form. Heavy lifting lives in dedicated modules.

const dropZone = document.getElementById('archive-drop');
const fileInput = document.getElementById('archive-input');

if (dropZone && fileInput) {
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('is-active');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-active'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleArchive(file);
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) await handleArchive(file);
  });
}

async function handleArchive(_file) {
  // TODO Phase 2: unzip, parse FIT/TCX, extract MMP, POST to /mmp/ingest.
  console.log('archive received');
}
