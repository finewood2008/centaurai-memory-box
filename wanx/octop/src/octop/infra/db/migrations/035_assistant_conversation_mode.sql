ALTER TABLE assistant_conversations ADD COLUMN conversation_mode TEXT
    CHECK (conversation_mode IN ('ask', 'craft', 'plan'));
UPDATE _schema_version SET version = 35;
