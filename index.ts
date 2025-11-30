// src/index.ts
import { Effect, Schedule, Console, pipe, Schema } from "effect"
import { HttpClient, FetchHttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { BunRuntime } from "@effect/platform-bun"

// --- Config ---
const config = {
  githubToken: process.env.GITHUB_TOKEN!,
  githubUsername: process.env.GITHUB_USERNAME!,
  ulanziHost: process.env.ULANZI_HOST!, // e.g., "192.168.1.100"
  pollIntervalMinutes: process.env.POLL_INTERVAL_MINUTES,
  commitChartDays: Number(process.env.COMMIT_CHART_DAYS || 64), // 16 days across x 4 days down with 2x2 squares
}

// --- Schemas ---
const GitHubPR = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  draft: Schema.Boolean,
  repository_url: Schema.String,
})

const GitHubSearchResponse = Schema.Struct({
  total_count: Schema.Number,
  items: Schema.Array(GitHubPR),
})

const GitHubCommit = Schema.Struct({
  commit: Schema.Struct({
    committer: Schema.Struct({
      date: Schema.String,
    }),
  }),
})

const GitHubCommitSearchResponse = Schema.Struct({
  items: Schema.Array(GitHubCommit),
})

const UlanziPayload = Schema.Struct({
  text: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.Struct({t: Schema.String, c: Schema.String})))),
  icon: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Number),
  draw: Schema.optional(Schema.Array(Schema.Struct({
    df: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.Number, Schema.String)),
    dp: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.String)),
    dl: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.Number, Schema.String)),
    dr: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.Number, Schema.String)),
    dc: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.String)),
    dfc: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.String)),
    dt: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.String, Schema.String)),
  }))),
})

// --- Types ---
type GitHubPR = Schema.Schema.Type<typeof GitHubPR>
type GitHubSearchResponse = Schema.Schema.Type<typeof GitHubSearchResponse>
type GitHubCommit = Schema.Schema.Type<typeof GitHubCommit>
type GitHubCommitSearchResponse = Schema.Schema.Type<typeof GitHubCommitSearchResponse>
type UlanziPayload = Schema.Schema.Type<typeof UlanziPayload>

// --- GitHub Service ---
const fetchOpenPRs = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient

  const query = encodeURIComponent(
    `author:${config.githubUsername} type:pr state:open`
  )

  const response = yield* client.get(
    `https://api.github.com/search/issues?q=${query}`,
    {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ulanzi-pr-monitor",
      },
    }
  )

  const validated = yield* HttpClientResponse.schemaBodyJson(GitHubSearchResponse)(response);

  return {
    total: validated.total_count,
    prs: validated.items,
  }
})

const fetchCommitActivity = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient

  // Get commits from the configured number of days
  const today = new Date()
  const daysAgo = new Date(today)
  daysAgo.setDate(today.getDate() - (config.commitChartDays - 1))

  const query = encodeURIComponent(
    `author:${config.githubUsername} committer-date:>=${daysAgo.toISOString().split('T')[0]}`
  )

  const perPage = 100

  // Fetch a single page of commits
  const fetchPage = (page: number) =>
    Effect.gen(function* () {
      const response = yield* client.get(
        `https://api.github.com/search/commits?q=${query}&per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${config.githubToken}`,
            Accept: "application/vnd.github.cloak-preview+json",
            "User-Agent": "ulanzi-pr-monitor",
          },
        }
      )
      const data = yield* HttpClientResponse.schemaBodyJson(GitHubCommitSearchResponse)(response)
      return data.items
    })

  // Fetch all pages using Effect.iterate
  const allItems = yield* Effect.iterate(
    { items: [] as any[], page: 1 },
    {
      while: ({ items, page }) => items.length < 1000 && (page === 1 || items.length % perPage === 0),
      body: ({ items, page }) =>
        Effect.gen(function* () {
          const newItems = yield* fetchPage(page)
          const allItems = items.concat(newItems)

          yield* Console.log(`Fetched page ${page}, got ${newItems.length} commits, total so far: ${allItems.length}`)

          return { items: allItems, page: page + 1 }
        }),
    }
  )

  // Group commits by day
  const commitsByDay = new Array(config.commitChartDays).fill(0)

  for (const commit of allItems.items) {
    const commitDate = new Date((commit as any).commit.committer.date)
    const daysDiff = Math.floor((today.getTime() - commitDate.getTime()) / (1000 * 60 * 60 * 24))
    if (daysDiff >= 0 && daysDiff < config.commitChartDays) {
      commitsByDay[config.commitChartDays - 1 - daysDiff]++ // Reverse order so today is last
    }
  }

  return {
    days: commitsByDay,
    total: allItems.items.length,
  }
})

// --- Ulanzi Service ---
const pushToUlanzi = (prCount: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    const payload: UlanziPayload = {
      text: prCount === 0 ? "No PRs" : [
        {t: `${prCount} `, c: '#8783D7'},
        {t: `PR${prCount > 1 ? "s" : ""}`, c: '#FFFFFF'},
      ],
      icon: "55529",
    }
    yield* Console.log('Puhsing to Ulanzi')
    yield* HttpClientRequest.post(`http://${config.ulanziHost}/api/custom?name=github`).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.flatMap(client.execute),
        Effect.asVoid
    )

    yield* Console.log(`Pushed to Ulanzi: ${payload.text}`)
  })

const pushCommitChartToUlanzi = (commitData: { days: number[]; total: number }) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    // GitHub-style contribution chart with 2x2 squares (4 pixels per day)
    const maxCommits = Math.max(...commitData.days, 1)

    // Display configuration: 32 columns, 8 rows
    // With 2x2 squares: 16 days across, 4 days down = 64 days max
    const squareSize = 2
    const daysAcross = 16
    const daysDown = 4

    // Convert HSL to hex color
    const hslToHex = (h: number, s: number, l: number): string => {
      l /= 100
      const a = s * Math.min(l, 1 - l) / 100
      const f = (n: number) => {
        const k = (n + h / 30) % 12
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
        return Math.round(255 * color).toString(16).padStart(2, '0')
      }
      return `#${f(0)}${f(8)}${f(4)}`
    }

    // Matrix-style color scheme using HSL with varying lightness
    const getColorForCommits = (commits: number): string => {
      if (commits === 0) return hslToHex(120, 50, 8) // Very dark green for no commits

      const intensity = Math.min(commits / Math.max(maxCommits, 1), 1)

      // Matrix green: Hue=120 (pure green), Saturation=100%, Lightness from 15% to 80%
      const lightness = 15 + (intensity * 65)

      return hslToHex(120, 100, lightness)
    }

    const drawCommands: Array<{df: [number, number, number, number, string]}> = []

    // Draw 2x2 squares for each day (column-first order)
    for (let i = 0; i < commitData.days.length && i < daysAcross * daysDown; i++) {
      const commits = commitData.days[i]
      const col = Math.floor(i / daysDown)
      const row = i % daysDown
      const x = col * squareSize
      const y = row * squareSize
      const color = getColorForCommits(commits)

      drawCommands.push({
        df: [x, y, squareSize, squareSize, color],
      })
    }

    const payload: UlanziPayload = {
      draw: drawCommands,
    }

    yield* Console.log('Pushing commit chart to Ulanzi')
    const response = yield* HttpClientRequest.post(`http://${config.ulanziHost}/api/custom?name=commits`).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.flatMap(client.execute)
    )

    if (response.status !== 200) {
      const body = yield* response.text
      yield* Console.log('Error pushing commit chart:', response.status, body)
    }

    yield* Console.log(`Pushed commit chart to Ulanzi: ${commitData.total} commits in last ${config.commitChartDays} days (2x2px squares per day)`)
  })

// --- Main Program ---
const pollOnce = Effect.gen(function* () {
  yield* Console.log("Fetching PRs...")

  const { total, prs } = yield* fetchOpenPRs

  yield* Console.log(`Found ${total} open PRs`)

  // Log PR titles for debugging
  for (const pr of prs) {
    yield* Console.log(`  - ${pr.title}`)
  }

  yield* pushToUlanzi(total)
})

const pollCommitsOnce = Effect.gen(function* () {
  yield* Console.log(`Fetching commit activity for last ${config.commitChartDays} days...`)

  const commitData = yield* fetchCommitActivity

  yield* Console.log(`Found ${commitData.total} commits in the last ${config.commitChartDays} days`)
  yield* Console.log(`Commits by day: ${commitData.days.join(', ')}`)

  yield* pushCommitChartToUlanzi(commitData)
})

const prProgram = pipe(
  pollOnce,
  Effect.catchAll((error) =>
    Console.error(`PR polling error: ${error}`)
  ),
  Effect.repeat(
    Schedule.spaced(`${Number(config.pollIntervalMinutes)} minutes`)
  )
)

const commitProgram = pipe(
  pollCommitsOnce,
  Effect.catchAll((error) =>
    Console.error(`Commit chart error: ${error}`)
  ),
  Effect.repeat(
    Schedule.spaced("1 day")
  )
)

const program = Effect.all([prProgram, commitProgram], { concurrency: "unbounded" })

// --- Run ---
pipe(
  program,
  Effect.provide(FetchHttpClient.layer),
  BunRuntime.runMain
)