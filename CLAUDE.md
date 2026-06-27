# Project: Space Blasters — Math Mission

A single-file HTML5 game (voice-answered math space shooter for kids). The ENTIRE app is
`index.html` — self-contained, no build step, no dependencies to install, no environment
variables or secrets (the Supabase leaderboard uses a public "publishable" key that is safe
to ship in client code).

## Your task when asked to deploy
1. Initialize git here (if not already), commit ALL files.
2. Create a new GitHub repo from this folder and push it (use the `gh` CLI).
3. Deploy to Vercel as a PRODUCTION deployment (Vercel CLI). It's a static site — framework
   preset = "Other", no build command, output = the repo root.
4. Attach the custom domain **smartergames.ai** to the Vercel project and set it as the
   production domain. (The domain is already in the user's Vercel account.)
5. If the user isn't logged in to `gh` or `vercel`, pause and walk them through the one-time
   login, then continue.

## Notes
- Keep `index.html` at the repo ROOT so it serves at the domain root.
- To update later: edit `index.html`, commit, and `git push` — Vercel auto-redeploys.
