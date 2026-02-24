import { GoogleGenerativeAI } from '@google/generative-ai'

// ─── Config ────────────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'sovereignangel'
const VERCEL_TOKEN = process.env.VERCEL_TOKEN
const CALLBACK_URL = process.env.CALLBACK_URL
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CUSTOM_DOMAIN_BASE = process.env.CUSTOM_DOMAIN_BASE || 'loricorpuz.com'

const uid = process.env.VENTURE_UID!
const ventureId = process.env.VENTURE_ID!
const spec = JSON.parse(process.env.VENTURE_SPEC || '{}')
const prd = JSON.parse(process.env.VENTURE_PRD || 'null')
const chatId = process.env.CHAT_ID
const eventType = process.env.EVENT_TYPE || 'build-venture'
const existingRepoName = process.env.REPO_NAME || ''
const iterateChanges = process.env.ITERATE_CHANGES || ''

// ─── GitHub REST helpers (raw fetch, no Octokit) ────────────────────────────

const GH_API = 'https://api.github.com'

async function gh(path: string, options?: RequestInit & { method?: string }) {
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`GitHub API ${options?.method || 'GET'} ${path} failed (${res.status}): ${body}`)
  }
  return res.json()
}

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

async function callGemini(prompt: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 65536 },
  })
  return result.response.text()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCodePrompt(spec: Record<string, any>, prd: Record<string, any> | null): string {
  const prdSection = prd ? `
PRD:
  Project Name: ${prd.projectName}
  Features:
${(prd.features || []).map((f: { priority: string; name: string; description: string }) => `    [${f.priority}] ${f.name}: ${f.description}`).join('\n')}
  Data Schema:
${prd.dataSchema || '  (none specified)'}
  User Flows:
${(prd.userFlows || []).map((f: string, i: number) => `    Flow ${i + 1}: ${f}`).join('\n')}
  Design Notes: ${prd.designNotes || 'Modern dark SaaS aesthetic'}
  Success Metrics:
${(prd.successMetrics || []).map((m: string) => `    - ${m}`).join('\n')}
` : ''

  return `Generate a complete proof-of-concept web application. Output ALL files needed to run this locally and deploy to Vercel.

PROJECT: ${spec.name}
DESCRIPTION: ${spec.oneLiner}
PROBLEM: ${spec.problem}
CUSTOMER: ${spec.targetCustomer}
SOLUTION: ${spec.solution}
${prdSection}
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
10. Follow the PRD's data schema and user flows if provided

OUTPUT FORMAT:
For each file, use this exact format:

=== FILE: path/to/file.tsx ===
[file contents]
=== END FILE ===

Generate a minimal but functional and visually polished application. Focus on the core feature working end-to-end.`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildIteratePrompt(spec: Record<string, any>, prd: Record<string, any> | null, changes: string, existingFiles: Array<{ path: string; content: string }>): string {
  const filesList = existingFiles.map(f => `- ${f.path}`).join('\n')

  return `You are modifying an existing proof-of-concept web application. The user wants these changes:

CHANGE REQUEST: ${changes}

PROJECT: ${spec.name}
DESCRIPTION: ${spec.oneLiner}

EXISTING FILES:
${filesList}

${prd ? `PRD: ${prd.projectName}\nDesign: ${prd.designNotes || 'Modern dark SaaS'}` : ''}

Only output the files that need to be MODIFIED or CREATED. Do not output unchanged files.

OUTPUT FORMAT:
For each modified/new file, use this exact format:

=== FILE: path/to/file.tsx ===
[complete file contents]
=== END FILE ===

Keep changes minimal. Only modify what's needed for the requested change.`
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

async function getRepoFiles(repoName: string): Promise<Array<{ path: string; content: string }>> {
  try {
    const tree = await gh(`/repos/${GITHUB_OWNER}/${repoName}/git/trees/main?recursive=true`)

    const files: Array<{ path: string; content: string }> = []
    for (const item of tree.tree) {
      if (item.type === 'blob' && item.path && !item.path.includes('node_modules') && !item.path.includes('.next')) {
        try {
          const data = await gh(`/repos/${GITHUB_OWNER}/${repoName}/contents/${item.path}`)
          if (data.content) {
            files.push({
              path: item.path,
              content: Buffer.from(data.content, 'base64').toString('utf-8'),
            })
          }
        } catch {
          // Skip files we can't read
        }
      }
    }
    return files
  } catch {
    return []
  }
}

// ─── Vercel Domain Helper ────────────────────────────────────────────────────

async function assignCustomDomain(projectName: string, subdomain: string): Promise<string | null> {
  if (!VERCEL_TOKEN) return null

  const customDomain = `${subdomain}.${CUSTOM_DOMAIN_BASE}`

  try {
    const domainRes = await fetch(`https://api.vercel.com/v10/projects/${projectName}/domains`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: customDomain }),
    })

    if (domainRes.ok) {
      console.log(`Custom domain assigned: ${customDomain}`)
      return customDomain
    } else {
      const errText = await domainRes.text()
      console.warn(`Custom domain assignment failed: ${errText}`)
      return null
    }
  } catch (err) {
    console.warn('Custom domain assignment failed:', err)
    return null
  }
}

// ─── Git Tree Push (shared between build & iterate) ──────────────────────────

async function pushFilesToRepo(repoName: string, files: Array<{ path: string; content: string }>, commitMessage: string) {
  const ref = await gh(`/repos/${GITHUB_OWNER}/${repoName}/git/ref/heads/main`)
  const latestCommitSha = ref.object.sha

  const latestCommit = await gh(`/repos/${GITHUB_OWNER}/${repoName}/git/commits/${latestCommitSha}`)

  const treeItems = await Promise.all(
    files.map(async (file) => {
      const blob = await gh(`/repos/${GITHUB_OWNER}/${repoName}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        }),
      })
      return {
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      }
    })
  )

  const newTree = await gh(`/repos/${GITHUB_OWNER}/${repoName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: latestCommit.tree.sha,
      tree: treeItems,
    }),
  })

  const newCommit = await gh(`/repos/${GITHUB_OWNER}/${repoName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: commitMessage,
      tree: newTree.sha,
      parents: [latestCommitSha],
    }),
  })

  await gh(`/repos/${GITHUB_OWNER}/${repoName}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  })
}

// ─── Build Pipeline (New Repo) ────────────────────────────────────────────────

async function buildNew() {
  console.log(`Building venture: ${spec.name} (${ventureId})`)

  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN (GH_PAT secret) is not configured')
  }
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY secret is not configured')
  }

  // Step 1: Generate code with Gemini
  console.log('Step 1: Generating code with Gemini...')
  await updateCallback({ status: 'generating' })

  const responseText = await callGemini(buildCodePrompt(spec, prd))
  const files = parseGeneratedFiles(responseText)

  if (files.length === 0) {
    throw new Error('No files generated from Gemini response')
  }

  console.log(`Generated ${files.length} files`)

  // Step 2: Create GitHub repo
  console.log('Step 2: Creating GitHub repo...')
  await updateCallback({ status: 'pushing' })

  const repoName = prd?.projectName
    ? `venture-${prd.projectName}-poc`
    : `venture-${(spec.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}-poc`

  const repo = await gh('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      description: spec.oneLiner as string,
      private: false,
      auto_init: true,
    }),
  })

  console.log(`Repo created: ${repo.html_url}`)

  // Brief delay to let GitHub finish initializing the repo
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Step 3: Push files via Git tree API
  console.log('Step 3: Pushing files...')
  await pushFilesToRepo(repoName, files, `Initial PoC generated by Thesis Engine\n\n${spec.oneLiner}`)
  console.log('Files pushed successfully')

  // Step 4: Deploy via Vercel
  let previewUrl = `https://${repoName}.vercel.app`
  let customDomain: string | null = null

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

        // Step 4b: Assign custom domain (e.g. projectname.loricorpuz.com)
        const subdomain = prd?.projectName || (spec.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
        customDomain = await assignCustomDomain(repoName, subdomain)
        if (customDomain) {
          previewUrl = `https://${customDomain}`
        }
      } else {
        const errText = await vercelRes.text()
        console.warn(`Vercel project creation failed: ${errText}`)
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
    customDomain,
    repoName,
    filesGenerated: files.length,
  })

  await sendTelegram([
    `*${spec.name} is live!*`,
    '',
    `${customDomain ? `Live: https://${customDomain}` : `Preview: ${previewUrl}`}`,
    `GitHub: ${repo.html_url}`,
    '',
    `_${files.length} files generated_`,
    '',
    '_Refine with Claude Code locally for higher quality._',
  ].join('\n'))

  console.log('Build complete!')
}

// ─── Iterate Pipeline (Existing Repo) ─────────────────────────────────────────

async function iterateExisting() {
  console.log(`Iterating on: ${spec.name} (${existingRepoName})`)
  console.log(`Changes: ${iterateChanges}`)

  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN (GH_PAT secret) is not configured')
  }
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY secret is not configured')
  }

  // Step 1: Fetch existing repo files for context
  console.log('Step 1: Reading existing codebase...')
  await updateCallback({ status: 'generating' })

  const existingFiles = await getRepoFiles(existingRepoName)
  console.log(`Read ${existingFiles.length} files from ${existingRepoName}`)

  // Step 2: Generate changes with Gemini
  console.log('Step 2: Generating changes with Gemini...')

  const responseText = await callGemini(buildIteratePrompt(spec, prd, iterateChanges, existingFiles))
  const files = parseGeneratedFiles(responseText)

  if (files.length === 0) {
    throw new Error('No file changes generated from Gemini response')
  }

  console.log(`Generated ${files.length} modified files`)

  // Step 3: Push changes to existing repo
  console.log('Step 3: Pushing changes...')
  await updateCallback({ status: 'pushing' })

  await pushFilesToRepo(existingRepoName, files, `Iterate: ${iterateChanges.slice(0, 72)}\n\nGenerated by Thesis Engine`)
  console.log('Changes pushed — Vercel will auto-redeploy')

  // Step 4: Success callback
  await updateCallback({ status: 'deploying' })

  const repoUrl = `https://github.com/${GITHUB_OWNER}/${existingRepoName}`
  const previewUrl = `https://${existingRepoName}.vercel.app`

  await new Promise(resolve => setTimeout(resolve, 3000))

  await updateCallback({
    status: 'live',
    repoUrl,
    previewUrl,
    repoName: existingRepoName,
    filesGenerated: files.length,
  })

  await sendTelegram([
    `*${spec.name} updated!*`,
    '',
    `_"${iterateChanges}"_`,
    '',
    `Preview: ${previewUrl}`,
    `GitHub: ${repoUrl}`,
    '',
    `_${files.length} files modified_`,
  ].join('\n'))

  console.log('Iteration complete!')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    if (eventType === 'iterate-venture') {
      await iterateExisting()
    } else {
      await buildNew()
    }
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
