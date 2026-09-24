#!/bin/bash
set -e

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}      GO Events Calendar — VM Setup                      ${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check requirements
echo -e "${BOLD}Checking requirements...${NC}"
command -v node  >/dev/null 2>&1 && echo -e "  ${GREEN}✓${NC} Node.js $(node -v)" || { echo -e "  ${RED}✗ Node.js not found${NC}. Install from https://nodejs.org"; exit 1; }
command -v npm   >/dev/null 2>&1 && echo -e "  ${GREEN}✓${NC} npm $(npm -v)"
command -v docker>/dev/null 2>&1 && echo -e "  ${GREEN}✓${NC} Docker $(docker --version | cut -d' ' -f3)" || echo -e "  ${YELLOW}⚠ Docker not found (optional)${NC}"
echo ""

# .env setup
if [ ! -f .env ]; then
  echo -e "${BOLD}Setting up configuration...${NC}"
  cp .env.example .env

  read -p "  Postgres connection string [postgres://go_calendar:password@localhost:5432/go_calendar]: " DB_URL
  DB_URL=${DB_URL:-postgres://go_calendar:password@localhost:5432/go_calendar}
  sed -i "s|DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env

  read -p "  Google Sheet ID (only needed for one-time 'npm run db:migrate') []: " SHEET_ID
  sed -i "s|SHEET_ID=.*|SHEET_ID=$SHEET_ID|" .env

  echo -e "  ${GREEN}✓${NC} .env file created"
else
  echo -e "  ${GREEN}✓${NC} .env already exists — skipping"
fi
echo ""

# credentials.json check
if [ ! -f credentials.json ]; then
  echo -e "${YELLOW}⚠  credentials.json not found.${NC}"
  echo "   Download your service account JSON from Google Cloud Console"
  echo "   and save it as credentials.json in this directory."
  echo "   (See README.md → Step 3 for instructions)"
  echo ""
else
  echo -e "  ${GREEN}✓${NC} credentials.json found"
fi

# Install npm packages
echo -e "${BOLD}Installing dependencies...${NC}"
npm install --production
echo -e "  ${GREEN}✓${NC} Dependencies installed"
echo ""

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}Setup complete! Next:${NC}"
echo ""
echo -e "  1. npm run db:init      (creates the Postgres schema)"
echo -e "  2. npm run db:migrate   (one-time: copies the Google Sheet in)"
echo -e "  3. Start the server:"
echo -e "     ${BOLD}Direct:${NC}  npm start"
echo -e "     ${BOLD}Docker:${NC}  docker-compose up -d"
echo ""
echo -e "  Dashboard → ${BOLD}http://localhost:3000${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
