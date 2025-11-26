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

const GitHubCommitActivity = Schema.Struct({
  days: Schema.Array(Schema.Number),
  total: Schema.Number,
})

const UlanziPayload = Schema.Struct({
  text: Schema.Union(Schema.String, Schema.Array(Schema.Struct({t: Schema.String, c: Schema.String}))),
  icon: Schema.String,
  duration: Schema.optional(Schema.Number),
  draw: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.optional(Schema.String),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    x1: Schema.optional(Schema.Number),
    y1: Schema.optional(Schema.Number),
    w: Schema.optional(Schema.Number),
    h: Schema.optional(Schema.Number),
    c: Schema.optional(Schema.String),
  }))),
})

// --- Types ---
type GitHubPR = Schema.Schema.Type<typeof GitHubPR>
type GitHubSearchResponse = Schema.Schema.Type<typeof GitHubSearchResponse>
type GitHubCommitActivity = Schema.Schema.Type<typeof GitHubCommitActivity>
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

  // Get commits from the last 7 days
  const today = new Date()
  const sevenDaysAgo = new Date(today)
  sevenDaysAgo.setDate(today.getDate() - 6) // Last 7 days including today

  const query = encodeURIComponent(
    `author:${config.githubUsername} type:commit committer-date:>=${sevenDaysAgo.toISOString().split('T')[0]}`
  )

  const response = yield* client.get(
    `https://api.github.com/search/commits?q=${query}&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github.cloak-preview+json",
        "User-Agent": "ulanzi-pr-monitor",
      },
    }
  )

  const data = yield* HttpClientResponse.json(response)
  const items = (data as any).items || []

  // Group commits by day (last 7 days)
  const commitsByDay = new Array(7).fill(0)

  for (const commit of items) {
    const commitDate = new Date((commit as any).commit.committer.date)
    const daysDiff = Math.floor((today.getTime() - commitDate.getTime()) / (1000 * 60 * 60 * 24))
    if (daysDiff >= 0 && daysDiff < 7) {
      commitsByDay[6 - daysDiff]++ // Reverse order so today is last
    }
  }

  return {
    days: commitsByDay,
    total: items.length,
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

    // GitHub-style contribution chart with squares
    const maxCommits = Math.max(...commitData.days, 1)
    const squareSize = 3
    const spacing = 1
    const startX = 2
    const startY = 1

    // Define color intensity levels (GitHub-style)
    const getColorForCommits = (commits: number): string => {
      if (commits === 0) return "#161B22" // Dark background (no commits)

      const intensity = Math.min(commits / Math.max(maxCommits, 4), 1)

      if (intensity <= 0.25) return "#0E4429" // Level 1 - darkest green
      if (intensity <= 0.5) return "#006D32"  // Level 2
      if (intensity <= 0.75) return "#26A641" // Level 3
      return "#39D353"                        // Level 4 - brightest green
    }

    const drawCommands = []

    // Draw squares for each day
    for (let i = 0; i < commitData.days.length; i++) {
      const commits = commitData.days[i]
      const x = startX + i * (squareSize + spacing)
      const y = startY
      const color = getColorForCommits(commits)

      drawCommands.push({
        type: "rf",
        x,
        y,
        w: squareSize,
        h: squareSize,
        c: color,
      })
    }

    const payload: UlanziPayload = {
      text: commitData.total === 0 ? "No commits" : [
        {t: `${commitData.total} `, c: '#39D353'},
        {t: `commit${commitData.total > 1 ? "s" : ""}`, c: '#FFFFFF'},
      ],
      icon: "53090",
      draw: drawCommands,
    }

    yield* Console.log('Pushing commit chart to Ulanzi')
    yield* HttpClientRequest.post(`http://${config.ulanziHost}/api/custom?name=commits`).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.flatMap(client.execute),
        Effect.asVoid
    )

    yield* Console.log(`Pushed commit chart to Ulanzi: ${commitData.total} commits in last 7 days`)
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
  yield* Console.log("Fetching commit activity...")

  const commitData = yield* fetchCommitActivity

  yield* Console.log(`Found ${commitData.total} commits in the last 7 days`)
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