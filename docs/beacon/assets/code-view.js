document.querySelectorAll('.panel-header-tabs').forEach((header) => {
  const buttons = Array.from(header.querySelectorAll('.tab-button'));
  const panel = header.closest('.panel');
  const label = document.getElementById('right-pane-label');
  const metadataTag = document.getElementById('page-metadata');
  const metadata = metadataTag ? JSON.parse(metadataTag.textContent) : null;
  const panels = panel ? Array.from(panel.querySelectorAll('.tab-panel')) : [];

  function show(target) {
    buttons.forEach((button) => {
      button.classList.toggle('active', button.dataset.target === target);
    });
    panels.forEach((panelElement) => {
      panelElement.classList.toggle('active', panelElement.dataset.panel === target);
    });
    if (!label || !metadata) {
      return;
    }
    label.textContent = target === 'test' ? metadata.testLabel : metadata.commentaryLabel;
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => show(button.dataset.target));
  });
});

const syncGroups = new Map();

document.querySelectorAll('.sync-scroll').forEach((element) => {
  const group = element.dataset.syncGroup;
  if (!group) {
    return;
  }
  const list = syncGroups.get(group) ?? [];
  list.push(element);
  syncGroups.set(group, list);
});

for (const elements of syncGroups.values()) {
  let syncing = false;

  function visibleElements() {
    return elements.filter((element) => element.offsetParent !== null);
  }

  function syncFrom(source) {
    if (syncing) {
      return;
    }
    const active = visibleElements();
    if (active.length < 2) {
      return;
    }
    const maxScrollTop = Math.max(source.scrollHeight - source.clientHeight, 0);
    const ratio = maxScrollTop === 0 ? 0 : source.scrollTop / maxScrollTop;

    syncing = true;
    try {
      for (const target of active) {
        if (target === source) {
          continue;
        }
        const targetMax = Math.max(target.scrollHeight - target.clientHeight, 0);
        target.scrollTop = targetMax * ratio;
      }
    } finally {
      syncing = false;
    }
  }

  for (const element of elements) {
    element.addEventListener('scroll', () => syncFrom(element));
  }
}
  