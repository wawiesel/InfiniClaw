# Cross-Bot IPC Messaging System - Complete Design Document

## 1. Problem Statement

**Current limitations:**
- Engineer and Commander cannot communicate directly
- Matrix forwarding requires both bots in both rooms (causes confusion)
- No way for bots to coordinate tasks or share information programmatically

**Goal:** Enable direct bot-to-bot communication without Matrix room overlap.

---

## 2. Architecture Overview

### 2.1 Core Components

```
┌─────────────────┐                           ┌─────────────────┐
│   Engineer      │                           │   Commander     │
│   (Cid)         │                           │   (Johnny5)     │
└────────┬────────┘                           └────────┬────────┘
         │                                             │
         │ MCP: send_bot_message                      │ MCP: send_bot_message
         │                                             │
         ▼                                             ▼
┌────────────────────────────────────────────────────────────────┐
│           Filesystem IPC Layer                                  │
│                                                                 │
│  /data/ipc/bot-messages/                                       │
│  ├── engineer/                                                 │
│  │   ├── inbox/    ← Messages TO engineer                     │
│  │   └── outbox/   ← Messages FROM engineer (audit log)       │
│  └── commander/                                                │
│      ├── inbox/    ← Messages TO commander                    │
│      └── outbox/   ← Messages FROM commander (audit log)      │
└────────────────────────────────────────────────────────────────┘
         ▲                                             ▲
         │                                             │
         │ IPC Watcher                                │ IPC Watcher
         │                                             │
┌────────┴────────┐                           ┌────────┴────────┐
│  Container      │                           │  Container      │
│  Message        │                           │  Message        │
│  Delivery       │                           │  Delivery       │
└─────────────────┘                           └─────────────────┘
```

---

## 3. Data Structures

### 3.1 Message Format
```typescript
interface BotMessage {
  id: string;                    // UUID v4
  from: "engineer" | "commander";
  to: "engineer" | "commander";
  content: string;               // The message payload
  timestamp: string;             // ISO 8601 format
  replyTo?: string;             // Optional: ID of message being replied to
  priority?: "normal" | "high";  // Future use: message prioritization
  metadata?: {                   // Optional: additional context
    task?: string;               // Task ID or name
    context?: string;            // Brief context
  };
}
```

### 3.2 Message File Naming
```
{timestamp}-{uuid}.json

Example: 2026-02-16T13-58-00-123Z-a1b2c3d4.json
```

### 3.3 Storage Locations
```
$INFINICLAW_ROOT/data/ipc/bot-messages/
├── engineer/
│   ├── inbox/     # Messages TO engineer (consumed on read)
│   └── outbox/    # Messages FROM engineer (permanent log)
└── commander/
    ├── inbox/     # Messages TO commander (consumed on read)
    └── outbox/    # Messages FROM commander (permanent log)
```

---

## 4. Implementation Phases

### Phase 1: Basic Messaging (MVP)
**Scope:** Send and manually receive messages

**Components:**
1. **MCP Tool: `send_bot_message`**
   - Write message to target bot's inbox
   - Copy to sender's outbox (audit trail)
   - Return message ID

2. **MCP Tool: `read_bot_messages`** *(new)*
   - Read all messages from own inbox
   - Delete messages after reading
   - Return array of messages

3. **Directory initialization**
   - Create structure on bot startup
   - Ensure permissions are correct

**Delivery:** Manual (bot explicitly reads inbox)

### Phase 2: Automatic Delivery
**Scope:** Messages delivered automatically to active sessions

**Components:**
1. **IPC Watcher Enhancement**
   - Monitor `bot-messages/{bot}/inbox/`
   - Detect new message files
   - Inject into active container session

2. **Container Message Handler**
   - Receive injected messages
   - Format for agent context
   - Track delivery status

3. **Delivery Notifications**
   - Confirm message received
   - Track read status

**Delivery:** Automatic (push to active session)

### Phase 3: Request/Response Pattern
**Scope:** Synchronous communication patterns

**Components:**
1. **MCP Tool: `send_bot_request`**
   - Send message + wait for reply
   - Timeout handling
   - Return response or error

2. **Reply Handling**
   - Track request/response pairs
   - Thread replies correctly
   - Timeout management

3. **State Management**
   - Pending requests tracking
   - Reply routing

---

## 5. MCP Tool Specifications

### 5.1 `send_bot_message` (Phase 1)

```typescript
{
  name: "send_bot_message",
  description: "Send a message to another bot via IPC",
  inputSchema: {
    bot: {
      type: "string",
      enum: ["engineer", "commander"],
      description: "Target bot to send message to"
    },
    message: {
      type: "string",
      description: "Message content"
    },
    replyTo: {
      type: "string",
      optional: true,
      description: "Message ID this is replying to"
    },
    metadata: {
      type: "object",
      optional: true,
      properties: {
        task: { type: "string", optional: true },
        context: { type: "string", optional: true }
      }
    }
  }
}
```

**Returns:**
```json
{
  "messageId": "a1b2c3d4-...",
  "status": "sent",
  "deliveryMethod": "inbox"
}
```

### 5.2 `read_bot_messages` (Phase 1)

```typescript
{
  name: "read_bot_messages",
  description: "Read pending messages from own inbox",
  inputSchema: {
    limit: {
      type: "number",
      optional: true,
      default: 10,
      description: "Maximum messages to read"
    },
    deleteAfterRead: {
      type: "boolean",
      optional: true,
      default: true,
      description: "Delete messages after reading"
    }
  }
}
```

**Returns:**
```json
{
  "messages": [
    {
      "id": "...",
      "from": "commander",
      "to": "engineer",
      "content": "...",
      "timestamp": "...",
      "replyTo": null
    }
  ],
  "hasMore": false
}
```

---

## 6. IPC Handler Integration

### 6.1 Existing IPC Commands
Current commands in `src/ipc.ts`:
- `register_group`
- `set_brain_mode`
- `restart_bot`

### 6.2 New IPC Command (Phase 2)

Add `deliver_bot_message` handler:

```typescript
case 'deliver_bot_message':
  // Called by IPC watcher when new message arrives
  if (data.message && data.messageId) {
    // Inject into active container session
    await deliverMessageToContainer(data.message);
    // Log delivery
    logger.info({ messageId: data.messageId }, 'Bot message delivered');
  }
  break;
```

### 6.3 IPC Watcher Enhancement (Phase 2)

```typescript
// In src/ipc.ts - add inbox watcher
function watchBotInbox(bot: string) {
  const inboxDir = path.join(DATA_DIR, 'ipc', 'bot-messages', bot, 'inbox');

  // Use chokidar or similar to watch directory
  fs.watch(inboxDir, async (event, filename) => {
    if (event === 'rename' && filename.endsWith('.json')) {
      const messagePath = path.join(inboxDir, filename);
      const message = JSON.parse(fs.readFileSync(messagePath, 'utf-8'));

      // Deliver to active container
      await injectMessageToSession(message);

      // Move to processed
      fs.unlinkSync(messagePath);
    }
  });
}
```

---

## 7. Security Considerations

### 7.1 Access Control
- Only bots can write to their own outbox
- Only bots can read from their own inbox
- Filesystem permissions enforce isolation

### 7.2 Message Validation
- Validate message structure on read
- Sanitize content before injection
- Rate limiting (future): prevent spam

### 7.3 Audit Trail
- All messages logged in outbox (permanent)
- Timestamps for forensics
- No deletion of outbox messages

---

## 8. Error Handling

### 8.1 Send Failures
- Inbox directory doesn't exist → Create it
- Disk full → Return error to sender
- Invalid target bot → Reject immediately

### 8.2 Read Failures
- Corrupted message file → Log and skip
- Permission denied → Escalate to user
- Empty inbox → Return empty array

### 8.3 Delivery Failures (Phase 2)
- No active container → Queue for next spawn
- Container crashed → Retry logic
- Timeout → Dead letter queue

---

## 9. Testing Strategy

### 9.1 Unit Tests
- Message serialization/deserialization
- File I/O operations
- Message validation

### 9.2 Integration Tests
1. Engineer sends message → Commander receives
2. Round-trip reply threading
3. Multiple messages in sequence
4. Edge cases (invalid bot, missing fields)

### 9.3 Manual Testing
1. Send simple message from Engineer to Commander
2. Commander reads and replies
3. Verify outbox logs both directions
4. Test with no active container

---

## 10. Migration & Rollout

### 10.1 Phase 1 Rollout
1. Add MCP tools to container/mcp-server
2. Create directory structure on bot startup
3. Deploy to both bots simultaneously
4. Test basic send/receive

### 10.2 Phase 2 Rollout
1. Add IPC watcher logic
2. Test automatic delivery in staging
3. Deploy with feature flag
4. Monitor for issues

### 10.3 Backwards Compatibility
- Existing IPC commands unaffected
- Matrix forwarding still works (deprecated but functional)
- Can run Phase 1 indefinitely before Phase 2

---

## 11. Future Enhancements

### 11.1 Message Queue (Phase 4)
- Priority queues
- Message expiration
- Retry policies

### 11.2 Broadcast Messages (Phase 5)
- Send to multiple bots
- Group messaging

### 11.3 Rich Message Types (Phase 6)
- Structured data payloads
- File attachments
- Action requests (like MCP tools)

---

## 12. Open Questions for Approval

1. **Phase 1 vs Phase 2**: Should we implement automatic delivery (Phase 2) immediately, or start with manual read (Phase 1)?

2. **Message Retention**: Should outbox messages be retained indefinitely, or pruned after N days?

3. **Delivery Confirmation**: Should we implement read receipts in Phase 1 or Phase 2?

4. **Error Handling**: Should failed messages go to a dead-letter queue, or just log and discard?

5. **Priority**: Should Phase 1 include priority handling, or save for Phase 2?

---

## 13. Recommended Approach

**Start with Phase 1 (Manual Read)**

Rationale:
- Simpler to implement and test
- Lower risk (no session injection)
- Gives us time to validate message format
- Can upgrade to Phase 2 once proven stable

**Timeline:**
- Phase 1: Immediate implementation (today)
- Phase 2: After 1 week of stable Phase 1 usage
- Phase 3+: As needed based on usage patterns

---

## 14. Implementation Checklist

### Phase 1 Tasks

#### Backend (nanoclaw)
- [ ] Add BotMessage interface to types.ts
- [ ] Create bot-messages directory structure initialization
- [ ] Implement message file I/O utilities
- [ ] Add message validation logic

#### MCP Server (container/mcp-server)
- [ ] Add send_bot_message tool definition
- [ ] Add read_bot_messages tool definition
- [ ] Implement send_bot_message handler
- [ ] Implement read_bot_messages handler
- [ ] Add error handling and logging

#### Testing
- [ ] Unit tests for message serialization
- [ ] Unit tests for file operations
- [ ] Integration test: Engineer → Commander
- [ ] Integration test: Commander → Engineer
- [ ] Integration test: Reply threading
- [ ] Manual testing with both bots

#### Documentation
- [ ] Update README with new MCP tools
- [ ] Add usage examples
- [ ] Document message format
- [ ] Document error codes

### Phase 2 Tasks (Future)
- [ ] Add IPC watcher for inbox monitoring
- [ ] Implement session injection mechanism
- [ ] Add delivery confirmation system
- [ ] Update tests for automatic delivery
- [ ] Performance testing under load

---

## 15. Approval Checklist

**Captain, please confirm:**

- [ ] Overall architecture is approved
- [ ] Phase 1 (manual read) is the correct starting point
- [ ] Message format is acceptable
- [ ] Directory structure is appropriate
- [ ] Security model is sufficient
- [ ] Ready to begin implementation

**Questions to answer:**
1. Which phase should we implement first?
2. Any modifications to the message format?
3. Any additional security requirements?
4. Any concerns about the filesystem approach?

---

**Status:** Awaiting approval to proceed with implementation.

**Next steps after approval:**
1. Implement MCP tools
2. Add directory initialization
3. Write tests
4. Deploy to both bots
5. Manual testing and validation
