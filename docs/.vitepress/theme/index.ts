import DefaultTheme from 'vitepress/theme'
import { nextTick, watch } from 'vue'
import { useRoute } from 'vitepress'
import mermaid from 'mermaid'
import './style.css'

async function renderMermaidDiagrams() {
  if (typeof window === 'undefined') return

  await nextTick()

  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('.vp-doc pre.mermaid')
  )

  if (!nodes.length) return

  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'loose',
    fontSize: 18,
    flowchart: {
      nodeSpacing: 40,
      rankSpacing: 55,
      padding: 18,
      useMaxWidth: true,
    },
    sequence: {
      diagramMarginX: 30,
      diagramMarginY: 20,
      actorMargin: 60,
      width: 180,
      height: 70,
      boxMargin: 12,
      boxTextMargin: 8,
      noteMargin: 12,
      messageMargin: 40,
    },
  })

  for (const node of nodes) {
    node.removeAttribute('data-processed')
  }

  await mermaid.run({ nodes })
}

export default {
  extends: DefaultTheme,
  setup() {
    const route = useRoute()

    if (typeof window === 'undefined') return

    watch(
      () => route.path,
      async () => {
        await renderMermaidDiagrams()
      },
      { immediate: true }
    )
  },
}
