# Build en deux etapes : better-sqlite3 se compile nativement, et on ne veut ni les
# outils de compilation ni les dependances de developpement dans l'image finale.

FROM node:22-slim AS build
WORKDIR /app

# python3/make/g++ sont requis par node-gyp pour better-sqlite3. Ils restent dans
# cette etape et ne suivent pas dans l'image finale.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Un utilisateur non privilegie : l'addon ne fait qu'ecouter et ecrire dans /app/data.
#
# `/app/data` DOIT exister ici, et appartenir a `node`. Docker n'attribue a un volume
# nomme la propriete du dossier de l'image que si ce dossier existe : sinon il le cree
# a la volee, en root, et le conteneur ne peut pas y ecrire. C'est exactement la panne
# qu'on vient de corriger, deplacee d'un cran.
RUN mkdir -p /app/config /app/data && chown -R node:node /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 7020

# /api/stats : leger, en memoire, et volontairement NON protege — c'est la sonde.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||7020)+'/api/stats',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
