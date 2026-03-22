// ===== Animated Empty State =====

function renderEmptyState(container) {
  const delays = [0.2, 0.45, 0.65, 0.8, 0.95, 1.1, 1.3, 1.5, 1.65, 1.8];
  let d = 0;
  const line = (html, cls = '') => {
    const delay = delays[d++] || (d * 0.15);
    return `<div class="mock-line ${cls}" style="animation-delay:${delay}s">${html}</div>`;
  };

  container.innerHTML = `
    <div class="empty-state-wrapper">
      <h3>No notes yet</h3>
      <p>Drop screenshots into a course folder and notes will appear here — ready to review.</p>

      <div class="mock-card">
        ${line(`<div class="mock-frontmatter">
title: Neural Network Architectures<br>
course: Deep Learning Fundamentals<br>
tags: [cnn, transformers, attention]
        </div>`)}

        ${line(`<div class="mock-heading">Key Concepts</div>`)}
        ${line(`<div class="mock-bullet">• <span class="mock-wikilink">[[Backpropagation]]</span> drives weight updates via gradient descent</div>`)}
        ${line(`<div class="mock-bullet">• <span class="mock-wikilink">[[Attention Mechanism]]</span> enables dynamic context weighting</div>`)}
        ${line(`<div class="mock-bullet">• <span class="mock-wikilink">[[Residual Connections]]</span> solve the vanishing gradient problem</div>`)}

        ${line(`<div class="mock-heading" style="margin-top:12px;">Visuals</div>`)}
        ${line(`<div class="mock-mermaid">
flowchart LR<br>
&nbsp;&nbsp;Input → Encoder → <span class="mock-wikilink">[[Attention]]</span><br>
&nbsp;&nbsp;<span class="mock-wikilink">[[Attention]]</span> → Decoder → Output
        </div>`)}
      </div>
    </div>
  `;
}
