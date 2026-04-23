# Agent MonDAI - Frontend Application Summary

Agent MonDAI is an intelligent orchestration platform and community portal built for the **CryptoMondays** community. It serves as a central hub for community members to connect, learn, and leverage integrated AI tools to navigate the crypto and Web3 ecosystem. The application is built using a modern frontend stack (Vue 3, Vite, Pinia, PrimeVue, TypeScript) backed securely by Supabase for authentication and database management.

This document summarizes the core functionality, architecture, and AI/Agent capabilities of the system to serve as a foundation for integrating a NanoClaw-based multiuser assistant.

---

## 1. Core Architecture

- **Frontend Framework**: Vue 3 (Composition API) with Vite.
- **State Management**: Pinia (Modules for auth, chat, members, events, etc.).
- **UI Components**: PrimeVue with Tailwind-like utility classes or custom PrimeVue themes.
- **Backend/Database**: Supabase (PostgreSQL, Row Level Security, Edge Functions).

## 2. Main Functional Areas

### 2.1 Authentication & Onboarding

- **Flow**: Supports Registration, Login, and Password Reset via Supabase Auth magic links and passwords.
- **Onboarding**: Replaces simple signups by putting users through a profile completion process, confirming expertise, interests, and basic information linking back to a broader Notion-based member import.
- **Roles**: Standard Members, Curators (managing platform submissions), and Administrators (system/AI configuration).

### 2.2 Community Portal Features

- **Profiles**: Rich member profiles tracking Web3 tags (expertise and interests), crypto wallet addresses, linked social accounts, and custom assigned Badges (like DAIAA).
- **Connect & Matchmaking**: A robust directory to search and connect with other members based on shared interests or explicit matchmaking opt-in properties.
- **Chapters & Events**: Localized community features showing CryptoMondays regional chapter data, home chapters, and integration with dynamic calendars (e.g., Luma or Meetup) for event tracking.
- **Education, Earn & Submissions**: Portals for community learning, potential earning opportunities in Web3, and a structured submission process where users provide content curated by moderators.
- **Feedback & Guides**: Help center and user feedback loops built-in.

---

## 3. AI & Agent Subsystem (Crucial for NanoClaw)

MonDAI relies heavily on contextualized AI chat to assist community members. The underlying data model demonstrates a well-thought-out foundation for an advanced agentic system.

### 3.1 LLM Configuration & Throttling

- **LLM Modes**: Users have adjustable LLM contexts stored in their Profile `llm_mode`:
  - `community`: Uses globally configured LLM settings and API keys defined by the Admin.
  - `personal`: Allows power users to supply their own LLM endpoints, providers, and API keys securely (`personal_llm_api_key_encrypted`).
  - `local`: Likely intended for localized edge models.
- **Token Management**: The `daily_token_limit` profile attribute tightly controls the maximum cost/usage for a given user on community-funded models. Global token counts are tracked per chat session and streamed down to the client.

### 3.2 Chat & Session Data Model

- **Sessions (`ChatSession`)**: Bound to a specific `userId`, maintaining historical context in the Supabase database.
- **Messages (`ChatMessage`)**:
  - Roles: `user`, `assistant`, `system`.
  - Distinguishes the `"source"` column (e.g., `"agent"` vs standard reply).
  - Explicitly models array states for intelligent context:
    - **Citations**: Linking Agent summaries back to specific documents, web URLs, or internal database records to establish trust.
    - **Tool Calls**: Storing JSON definitions of agent workflow actions and statuses (`pending`, `running`, `completed`, `error`).
- **Streaming UI**: Real-time response generation utilizing a custom `StreamChunk` UI handler to stream content, tool statuses, and token usage statistics natively.

---

## 4. Considerations for a NanoClaw Multiuser Assistant

If building a **NanoClaw based agent** acting as a multiuser assistant, consider utilizing or extending these exact systems:

1. **Leverage the Contextual `Connect` System**: Give NanoClaw tools that securely access the `MemberSearchFilters` and profile data to recommend specific members or events natively inside the chat interface.
2. **Utilize Standardized Over-the-wire Formats**: When NanoClaw delegates tasks, format actions sequentially as `ToolCall` objects that the UI already knows how to render.
3. **Database Integration**: Ensure your NanoClaw agent directly updates `chat_sessions` and `chat_messages` tables so the frontend's realtime or polling state managers naturally sync without complex web socket middleware. Use the "agent" `source` flag to help UI rendering differentiate between simple bots and complex NanoClaw orchestrations.
4. **Knowledge Retrieval**: Pass the specific `tags` and `home_chapter_name` belonging to the authenticated User as system prompts for NanoClaw to ensure its responses strictly pertain to that user's geographic community and professional web3 goals.
