import Anthropic from '@anthropic-ai/sdk'
import { Octokit } from '@octokit/rest'

// ─── Config ────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'sovereignangel'
const VERCEL_TOKEN = process.env.VERCEL_TOKEN
const CALLBACK_URL = process.env.CALLBACK_URL
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

const uid = process.env.VENTURE_UID!
const ventureId = process.env.VENTURE_ID!
const spec = JSON.parse(process.env.VENTURE_SPEC || '{}')
const chatId = process.env.CHAT_ID

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function updateCallback(data: Record<string, unknown>) {
  if (!CALLBACK_URL || !INTERNAL_API_SECRET) return
  try {
    await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INTERNAL_API_SECRET}`,
      },
      body: JSON.stringify({ uid, ventureId, ...data }),
    })
  } catch (err) {
    console.error('Callback failed:', err)
  }
}

async function sendTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
  } catch (err) {
    console.error('Telegram send failed:', err)
  }
}

function buildCodePrompt(spec: Record<string, unknown>): string {
  return `Generate a complete proof-of-concept web application. Output ALL files needed to run this locally and deploy to Vercel.

PROJECT: ${spec.name}
DESCRIPTION: ${spec.oneLiner}
PROBLEM: ${spec.problem}
CUSTOMER: ${spec.targetCustomer}
SOLUTION: ${spec.solution}

MVP FEATURES:
${(spec.mvpFeatures as string[])?.map((f: string, i: number) => `${i + 1}. ${f}`).join('\n') || 'Basic landing page with core feature'}

TECH STACK: ${(spec.techStack as string[])?.join(', ') || 'Next.js, Tailwind, Vercel'}
API INTEGRATIONS: ${(spec.apiIntegrations as string[])?.join(', ') || 'None'}
REVENUE MODEL: ${spec.revenueModel} (${spec.pricingIdea})

REQUIREMENTS:
1. Use Next.js 14 with App Router and TypeScript
2. Use Tailwind CSS for styling
3. Include a compelling landing page with the value proposition, hero section, feature highlights, and CTA
4. Include a basic working demo of the core feature (even if mocked)
5. Include package.json with all dependencies
6. Include a README.md with setup instructions
7. Make it deployable to Vercel with zero config
8. Use clean, modern design — dark or light theme, professional typography
9. Include a pricing section on the landing page based on the revenue model

OUTPUT FORMAT:
For each file, use this exact format:

=== FILE: path/to/file.tsx ===
[file contents]
=== END FILE ===

Generate a minimal but functional and visually polished application. Focus on the core feature working end-to-end.`
}

function parseGeneratedFiles(text: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  const regex = /=== FILE: (.+?) ===\n([\s\S]*?)(?==== END FILE ===)/g
  let match
  while ((match = regex.exec(text)) !== null) {
    files.push({ path: match[1].trim(), content: match[2].trim() })
  }
  return files
}

// ─── Main Build Pipeline ───────────────────────────────────────────────────────

async function main() {
  console.log(`Building venture: ${spec.name} (${ventureId})`)

  const octokit = new Octokit({ auth: GITHUB_TOKEN })

  try {
    // Step 1: Generate code with Claude
    console.log('Step 1: Generating code with Claude...')
    await updateCallback({ status: 'generating' })

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      messages: [{ role: 'user', content: buildCodePrompt(spec) }],
    })

    const responseText = response.content[0].type === 'text' ? response.content[0].text : ''
    const files = parseGeneratedFiles(responseText)

    if (files.length === 0) {
      throw new Error('No files generated from Claude response')
    }

    console.log(`Generated ${files.length} files`)

    // Step 2: Create GitHub repo
    console.log('Step 2: Creating GitHub repo...')
    await updateCallback({ status: 'pushing' })

    const repoName = `venture-${(spec.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}-poc`

    const { data: repo } = await octokit.repos.create({
      name: repoName,
      description: spec.oneLiner as string,
      private: false,
      auto_init: true,
    })

    console.log(`Repo created: ${repo.html_url}`)

    // Step 3: Push files via Git tree API
    console.log('Step 3: Pushing files...')

    // Get default branch latest commit
    const { data: ref } = await octokit.git.getRef({
      owner: GITHUB_OWNER,
      repo: repoName,
      ref: 'heads/main',
    })
    const latestCommitSha = ref.object.sha

    const { data: latestCommit } = await octokit.git.getCommit({
      owner: GITHUB_OWNER,
      repo: repoName,
      commit_sha: latestCommitSha,
    })

    // Create blobs for all files
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const { data: blob } = await octokit.git.createBlob({
          owner: GITHUB_OWNER,
          repo: repoName,
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        })
        return {
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blob.sha,
        }
      })
    )

    // Create tree
    const { data: newTree } = await octokit.git.createTree({
      owner: GITHUB_OWNER,
      repo: repoName,
      base_tree: latestCommit.tree.sha,
      tree: treeItems,
    })

    // Create commit
    const { data: newCommit } = await octokit.git.createCommit({
      owner: GITHUB_OWNER,
      repo: repoName,
      message: `Initial PoC generated by Thesis Engine\n\n${spec.oneLiner}`,
      tree: newTree.sha,
      parents: [latestCommitSha],
    })

    // Update ref
    await octokit.git.updateRef({
      owner: GITHUB_OWNER,
      repo: repoName,
      ref: 'heads/main',
      sha: newCommit.sha,
    })

    console.log('Files pushed successfully')

    // Step 4: Deploy via Vercel
    let previewUrl = `https://${repoName}.vercel.app`

    if (VERCEL_TOKEN) {
      console.log('Step 4: Creating Vercel project...')
      await updateCallback({ status: 'deploying' })

      try {
        const vercelRes = await fetch('https://api.vercel.com/v10/projects', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${VERCEL_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: repoName,
            framework: 'nextjs',
            gitRepository: {
              type: 'github',
              repo: `${GITHUB_OWNER}/${repoName}`,
            },
          }),
        })

        if (vercelRes.ok) {
          const project = await vercelRes.json()
          previewUrl = `https://${project.name}.vercel.app`
          console.log(`Vercel project created: ${previewUrl}`)
        } else {
          const errText = await vercelRes.text()
          console.warn(`Vercel project creation failed: ${errText}`)
          console.warn('Repo is ready — deploy manually from Vercel dashboard')
        }
      } catch (vercelErr) {
        console.warn('Vercel deployment failed:', vercelErr)
      }
    } else {
      console.log('Step 4: Skipped (no VERCEL_TOKEN)')
    }

    // Step 5: Success callback
    console.log('Step 5: Sending success callback...')
    await updateCallback({
      status: 'live',
      repoUrl: repo.html_url,
      previewUrl,
      repoName,
      filesGenerated: files.length,
    })

    // Send Telegram notification
    await sendTelegram([
      `*${spec.name} is live!*`,
      '',
      `Preview: ${previewUrl}`,
      `GitHub: ${repo.html_url}`,
      '',
      `_${files.length} files generated_`,
    ].join('\n'))

    console.log('Build complete!')

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    console.error('Build failed:', msg)

    await updateCallback({
      status: 'failed',
      errorMessage: msg,
    })

    await sendTelegram(
      `*Build failed for ${spec.name}*\n\n_${msg}_\n\nSpec is saved. You can retry from the dashboard.`
    )

    process.exit(1)
  }
}

main()
