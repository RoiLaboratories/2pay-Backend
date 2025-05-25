-- First, drop existing policies
DROP POLICY IF EXISTS "Users can view their own contributions" ON contributions;
DROP POLICY IF EXISTS "Users can create their own contributions" ON contributions;
DROP POLICY IF EXISTS "Contract can update contribution status" ON contributions;

-- Disable RLS for contributions table since we handle auth in our middleware
ALTER TABLE contributions DISABLE ROW LEVEL SECURITY;

-- Create policies for other tables if needed
CREATE POLICY "Public read access to pools"
    ON pools FOR SELECT
    USING (true);

-- Note: Keep RLS enabled for pools table
ALTER TABLE pools ENABLE ROW LEVEL SECURITY;
