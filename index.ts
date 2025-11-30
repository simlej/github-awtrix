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

const UlanziPayload = Schema.Struct({
  text: Schema.Union(Schema.String, Schema.Array(Schema.Struct({t: Schema.String, c: Schema.String}))),
  icon: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Number),
  draw: Schema.optional(Schema.Array(Schema.Struct({
    dl: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.Number, Schema.String)),
  }))),
})

// --- Types ---
type GitHubPR = Schema.Schema.Type<typeof GitHubPR>
type GitHubSearchResponse = Schema.Schema.Type<typeof GitHubSearchResponse>
type UlanziPayload = Schema.Schema.Type<typeof UlanziPayload>

// --- GitHub Service ---
const fetchMergedPRs = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient

  const currentYear = new Date().getFullYear()
  const query = encodeURIComponent(
    `author:${config.githubUsername} type:pr is:merged merged:${currentYear}-01-01..${currentYear}-12-31`
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

// --- Ulanzi Service ---
const pushToUlanzi = (prCount: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    // Calculate year progress
    const now = new Date()
    const yearStart = new Date(now.getFullYear(), 0, 1)
    const yearEnd = new Date(now.getFullYear() + 1, 0, 1)
    const yearProgress = (now.getTime() - yearStart.getTime()) / (yearEnd.getTime() - yearStart.getTime())

    // Create a progress bar on the bottom line (y=7, assuming 8px height display)
    // Assuming 32px width display, with 8px icon on the left
    const displayWidth = 32
    const iconWidth = 8
    const progressBarWidth = displayWidth - iconWidth
    const progressPixels = Math.floor(yearProgress * progressBarWidth)

    const draw = []

    // Draw background line (dark gray) - starts after the icon
    if (progressPixels < progressBarWidth) {
      draw.push({
        dl: [iconWidth + progressPixels, 7, displayWidth - 1, 7, "#333333"] as const
      })
    }

    // Draw progress line (green) - starts after the icon
    if (progressPixels > 0) {
      draw.push({
        dl: [iconWidth, 7, iconWidth + progressPixels - 1, 7, "#40C463"] as const
      })
    }

    const payload: UlanziPayload = {
      text: [{t:`${prCount} `, c: "#8783D7"}],
      draw,
      icon: '55529',
      // icon: "45205"
      // icon: "2327", // Github
      // icon: "4373", // Prompt
    }
    yield* Console.log('Puhsing to Ulanzi')
    yield* HttpClientRequest.post(`http://${config.ulanziHost}/api/custom?name=github`).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.flatMap(client.execute),
        Effect.asVoid
    )

    yield* Console.log(`Pushed to Ulanzi: ${prCount} PRs with year progress bar`)
  })

// --- Main Program ---
const pollOnce = Effect.gen(function* () {
  yield* Console.log("Fetching merged PRs...")

  const { total, prs } = yield* fetchMergedPRs

  yield* Console.log(`Found ${total} merged PRs in ${new Date().getFullYear()}`)

  // Log PR titles for debugging
  for (const pr of prs) {
    yield* Console.log(`  - ${pr.title}`)
  }

  yield* pushToUlanzi(total)
})

const program = pipe(
  pollOnce,
  Effect.catchAll((error) =>
    Console.error(`Error: ${error}`)
  ),
  Effect.repeat(
    Schedule.spaced(`${Number(config.pollIntervalMinutes)} minutes`)
  )
)

// --- Run ---
pipe(
  program,
  Effect.provide(FetchHttpClient.layer),
  BunRuntime.runMain
)