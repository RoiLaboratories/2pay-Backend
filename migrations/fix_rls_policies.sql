-- First, drop existing policies
DROP POLICY IF EXISTS "Users can view their own contributions" ON contributions;
DROP POLICY IF EXISTS "Users can create their own contributions" ON contributions;
DROP POLICY IF EXISTS "Contract can update contribution status" ON contributions;

-- Create new policies that work with JWT claims instead of auth.uid()
CREATE POLICY "Users can view their own contributions"
    ON contributions FOR SELECT
    USING (
        user_address = LOWER(current_setting('request.jwt.claims')::json->>'address')
    );

CREATE POLICY "Users can create their own contributions"
    ON contributions FOR INSERT
    WITH CHECK (
        user_address = LOWER(current_setting('request.jwt.claims')::json->>'address')
    );

CREATE POLICY "Contract can update contribution status"
    ON contributions FOR UPDATE
    USING (true)
    WITH CHECK (true);

-- Enable RLS
ALTER TABLE contributions ENABLE ROW LEVEL SECURITY;
