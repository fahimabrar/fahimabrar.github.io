// Theme toggle
(function () {
    const root = document.documentElement;
    const saved = localStorage.getItem('themePref');
    if (saved) root.setAttribute('data-theme', saved);
    else root.setAttribute('data-theme', 'light');
    const btn = document.getElementById('themeToggle');
    function updateIcon() { btn.textContent = root.getAttribute('data-theme') === 'light' ? 'Dark' : 'Light'; }
    updateIcon();
    btn.addEventListener('click', function () {
        const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        root.setAttribute('data-theme', next);
        localStorage.setItem('themePref', next);
        updateIcon();
    });
})();

document.getElementById('year').textContent = new Date().getFullYear();

// Projects filter
(function () {
    const chips = Array.from(document.querySelectorAll('.chip'));
    const cards = Array.from(document.querySelectorAll('.proj'));
    function apply(filter) {
        cards.forEach(c => {
            const tags = (c.getAttribute('data-tags') || '').split(',').map(s => s.trim());
            c.style.display = (filter === 'All' || tags.includes(filter)) ? '' : 'none';
        });
    }
    chips.forEach(ch => {
        ch.addEventListener('click', () => {
            chips.forEach(x => x.setAttribute('aria-pressed', 'false'));
            ch.setAttribute('aria-pressed', 'true');
            apply(ch.getAttribute('data-filter'));
        });
    });
})();

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

window.addEventListener('scroll', () => {
    const header = document.getElementById('topbar');
    header.classList.toggle('scrolled', window.scrollY > 50);
});

document.addEventListener('DOMContentLoaded', () => {
    if (!window.location.hash) window.scrollTo(0, 0);
    const container = document.querySelector('.animated-background');
    for (let i = 0; i < 5; i++) {
        const p = document.createElement('div');
        p.classList.add('particle');
        p.style.width = p.style.height = `${Math.random() * 200 + 100}px`;
        p.style.left = `${Math.random() * 100}%`;
        p.style.top = `${Math.random() * 100}%`;
        p.style.animationDuration = `${Math.random() * 30 + 20}s`;
        p.style.animationDelay = `-${Math.random() * 10}s`;
        container.appendChild(p);
    }
});

function toggleChat() { document.getElementById('chatbot-popup').classList.toggle('hidden'); }

const modal = document.getElementById('projectModal');
function openModal(card) {
    document.getElementById('modalTitle').textContent = card.getAttribute('data-title');
    document.getElementById('modalImg').src = card.getAttribute('data-image');
    document.getElementById('modalImg').style.display = 'block';
    document.getElementById('modalImg').parentElement.style.display = 'block';
    document.getElementById('modalDesc').innerHTML = card.getAttribute('data-details');
    document.getElementById('modalLink').href = card.getAttribute('data-link');
    document.getElementById('modalLink').style.display = 'inline-flex';
    const modalTags = document.getElementById('modalTags');
    modalTags.innerHTML = '';
    card.querySelectorAll('.tag').forEach(t => { const c = t.cloneNode(true); c.style.background = 'var(--panel)'; c.style.border = '1px solid var(--line)'; modalTags.appendChild(c); });
    modal.classList.add('open');
    document.body.classList.add('modal-open');
}
function closeModal(e) { modal.classList.remove('open'); document.body.classList.remove('modal-open'); }
function openTestimonialModal(el) {
    document.getElementById('modalTitle').textContent = el.querySelector('figcaption > div:first-child').textContent;
    document.getElementById('modalImg').parentElement.style.display = 'none';
    document.getElementById('modalDesc').innerHTML = '<blockquote class="testimonial-quote">' + el.querySelector('blockquote').innerHTML + '</blockquote><p class="testimonial-author"><strong>' + el.querySelector('figcaption > div:first-child').textContent + '</strong><br><span class="muted">' + el.querySelector('figcaption > div:last-child').textContent + '</span></p>';
    document.getElementById('modalTags').innerHTML = '';
    document.getElementById('modalLink').style.display = 'none';
    modal.classList.add('open');
    document.body.classList.add('modal-open');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });

// Video banner
function playIntroVideo() {
    const placeholder = document.getElementById('videoPlaceholder');
    const banner = document.getElementById('videoBanner');
    const playerDiv = document.getElementById('bunnyPlayer');
    if (placeholder.classList.contains('hidden')) return;
    playerDiv.style.display = 'block';
    playerDiv.innerHTML = '<iframe src="https://iframe.mediadelivery.net/embed/620363/657d4b7e-0837-4e44-8f4f-f5115cfea3b7?autoplay=true" style="width:100%;height:100%;border:none;" allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture;" allowfullscreen></iframe>';
    placeholder.classList.add('hidden');
    banner.style.cursor = 'default';
    banner.onclick = null;
}
// Spawn floating particles in video banner placeholder
(function() {
    const pc = document.getElementById('vParticles');
    if (pc) {
        for (let i = 0; i < 20; i++) {
            const s = document.createElement('span');
            s.style.left = Math.random() * 100 + '%';
            s.style.top = Math.random() * 100 + '%';
            s.style.animationDelay = (Math.random() * 4) + 's';
            s.style.animationDuration = (Math.random() * 3 + 3) + 's';
            pc.appendChild(s);
        }
    }
})();

// Mobile menu
const navToggle = document.getElementById('navToggle');
const mainNav = document.getElementById('mainNav');
if (navToggle) navToggle.addEventListener('click', () => { navToggle.classList.toggle('open'); mainNav.classList.toggle('open'); });
mainNav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { navToggle.classList.remove('open'); mainNav.classList.remove('open'); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mainNav.classList.contains('open')) { navToggle.classList.remove('open'); mainNav.classList.remove('open'); } });
