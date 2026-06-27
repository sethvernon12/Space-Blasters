# Deploy with Claude Code (Terminal)

## Easiest: just paste this prompt to Claude Code
Open Claude Code inside this folder, then paste:

    Create a new public GitHub repo named "space-blasters" from this folder, commit all
    files, and push. Then deploy it to Vercel as a production deployment (it's a single
    static index.html, no build step), and attach the domain smartergames.ai to the
    project as the production domain. If I'm not logged in to gh or vercel, walk me
    through the one-time login first, then continue.

Approve the commands when it asks. When it needs you to log in, it will tell you.

## One-time logins you'll be prompted for
- GitHub:  `gh auth login`     (choose HTTPS; a browser window will open)
- Vercel:  `vercel login`      (a browser window will open)

## Manual commands (fallback, if you'd rather run them yourself)
    gh auth login
    git init
    git add -A
    git commit -m "Space Blasters — math game"
    gh repo create space-blasters --public --source=. --push

    npm i -g vercel        # if vercel isn't installed
    vercel --prod          # follow the prompts (creates/links the project)

Then attach the domain — easiest in the Vercel dashboard:
  Vercel -> your project -> Settings -> Domains -> Add -> smartergames.ai -> set as Production
(or via CLI:  `vercel domains add smartergames.ai`  then assign it to the project.)

## After it's live
Any future change: replace `index.html`, then `git add -A && git commit -m "update" && git push`.
Vercel redeploys automatically.
