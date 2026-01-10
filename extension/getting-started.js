// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabId = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tabId).classList.add('active');
  });
});

// Theme toggle
const themeToggle = document.getElementById('themeToggle');
const sunIcon = document.getElementById('sunIcon');
const moonIcon = document.getElementById('moonIcon');
const themeLabel = document.getElementById('themeLabel');

// Check saved preference using chrome.storage
chrome.storage.local.get(['apexTheme'], (result) => {
  if (result.apexTheme === 'light') {
    applyLightMode();
  }
});

function applyLightMode() {
  document.body.classList.add('light-mode');
  sunIcon.style.display = 'block';
  moonIcon.style.display = 'none';
  themeLabel.textContent = 'Dark';
}

function applyDarkMode() {
  document.body.classList.remove('light-mode');
  sunIcon.style.display = 'none';
  moonIcon.style.display = 'block';
  themeLabel.textContent = 'Light';
}

themeToggle.addEventListener('click', () => {
  const isCurrentlyLight = document.body.classList.contains('light-mode');
  
  if (isCurrentlyLight) {
    applyDarkMode();
    chrome.storage.local.set({ apexTheme: 'dark' });
  } else {
    applyLightMode();
    chrome.storage.local.set({ apexTheme: 'light' });
  }
});

// Copy code - attach to all copy buttons
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const pre = btn.parentElement.querySelector('pre');
    const text = pre.textContent;
    
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.style.background = '#22c55e';
      btn.style.borderColor = '#22c55e';
      btn.style.color = 'white';
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 2000);
    });
  });
});

