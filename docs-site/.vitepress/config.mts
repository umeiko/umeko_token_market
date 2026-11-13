import { defineConfig, type DefaultTheme } from 'vitepress'

const base = process.env.DOCS_BASE || '/umeko_token_market/'
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('DOCS_BASE must be / or a slash-delimited path.')

function sidebar(): DefaultTheme.SidebarItem[] {
  return [
    { text: '开始使用', items: [
      { text: '五分钟上手', link: '/start/quick-start' },
      { text: '部署与更新', link: '/start/install' },
      { text: '邮件发件配置', link: '/start/email' }
    ] },
    { text: '使用指南', items: [
      { text: '云端管理', link: '/guide/cloud' },
      { text: '自定义供应商与别名', link: '/guide/providers' },
      { text: '注册用户与自助门户', link: '/guide/users' },
      { text: '本地 CLI、Web 与 QML', link: '/guide/local' },
      { text: '私人远程工作台', link: '/guide/remote' },
      { text: '计费、额度与并发', link: '/guide/billing' },
      { text: '安全与生产检查', link: '/guide/security' }
    ] },
    { text: '技术参考', items: [
      { text: '架构设计', link: '/reference/architecture' },
      { text: 'API 接口参考', link: '/reference/api' },
      { text: '反向隧道协议', link: '/reference/tunnel' },
      { text: 'utoken 命令参考', link: '/reference/cli' },
      { text: '开发与构建', link: '/reference/development' }
    ] },
    { text: '帮助', items: [{ text: '常见问题', link: '/faq' }] }
  ]
}

export default defineConfig({
  title: 'Umeko Token Relay',
  description: 'Umeko Token Relay 文档：云端中转、本地 utoken、API 分发、计费、并发与反向隧道协议。',
  base,
  srcExclude: ['README.md', 'node_modules/**'],
  cleanUrls: false,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }]],
  markdown: { theme: { light: 'github-light', dark: 'github-dark' } },
  themeConfig: {
    logo: { src: '/logo.svg', alt: 'Umeko Token Relay' },
    siteTitle: 'Umeko Docs',
    nav: [
      { text: '快速开始', link: '/start/quick-start' },
      { text: '使用指南', link: '/guide/cloud' },
      { text: '架构', link: '/reference/architecture' },
      { text: 'API', link: '/reference/api' }
    ],
    sidebar: sidebar(),
    outline: { label: '本页内容', level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    editLink: { pattern: 'https://github.com/umeiko/umeko_token_market/edit/main/docs-site/:path', text: '在 GitHub 上完善此页' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/umeiko/umeko_token_market' }],
    externalLinkIcon: true,
    returnToTopLabel: '回到顶部', sidebarMenuLabel: '目录', darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换为浅色', darkModeSwitchTitle: '切换为深色',
    skipToContentLabel: '跳转到正文',
    notFound: { title: '没有找到这一页', quote: '试试搜索，或者回到首页继续。', linkText: '回到首页', linkLabel: '回到文档首页' },
    footer: { message: '自托管模型，自由分发。', copyright: 'Umeko Token Relay · <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer nofollow">黔ICP备2026019339号</a>' },
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            tokenize: (text: string) => Array.from(
              new Intl.Segmenter('zh', { granularity: 'word' }).segment(text),
              segment => segment.isWordLike ? segment.segment.toLowerCase() : ''
            ).filter(Boolean)
          }
        },
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有找到相关内容', resetButtonTitle: '清空搜索',
                backButtonTitle: '关闭搜索', displayDetails: '显示详情',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
              }
            }
          }
        }
      }
    }
  }
})
