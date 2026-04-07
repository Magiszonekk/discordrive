FROM node:22-alpine

# argon2 requires native compilation
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY . .

# Remove the file:../galery-plugin dependency — outside repo, not available in Docker
RUN node -e "\
  const fs = require('fs');\
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));\
  delete pkg.dependencies?.galery;\
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));\
"

RUN pnpm install --no-frozen-lockfile

RUN pnpm db:generate

# Empty .env satisfies --env-file flag; real values come from Docker environment
RUN touch .env

EXPOSE 3000

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
