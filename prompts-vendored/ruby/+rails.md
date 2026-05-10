---
id: ruby.rails
description: Ruby on Rails — sourced from rubocop-rails, brakeman, the Rails security guide.
extends: [ruby/base]
---

# Rails checks

In addition to the Ruby rules, apply these on Rails projects.

## ActiveRecord

- **N+1 queries** — `Post.all.each { |p| p.comments }` triggers a query per post. Flag, suggest `Post.includes(:comments)` or `.preload(:comments)` or `.eager_load(:comments)` depending on the join semantics needed.
- **`update_all` / `delete_all`** without a `where` — flag block-severity, will hit every row.
- **`find_by_sql(...)` with interpolation** — flag, SQL injection. Use `sanitize_sql_array` or parameterized queries.
- **`where("name = '#{params[:name]}'")`** — flag block-severity. Use `where(name: params[:name])` or `where("name = ?", params[:name])`.
- **`pluck(:id)` in a transaction with subsequent updates by those ids** — flag if the rows can change between pluck and update; suggest a single SQL statement.
- **Missing index on a foreign key or a column used in `where`** — flag with severity medium. Migrations should add the index.

## Migrations

- **`change_column_null :table, :column, false` without a backfill** — flag, fails if any existing row is null.
- **`add_column ... default: value` on a large table without `algorithm: :concurrently` (PG) / `change_column_default` first** — flag, table rewrite locks production.
- **`remove_column` in a deploy that the running app still reads** — flag. Two-step: ignore_columns first, deploy, then remove.

## Controllers & params

- **`params[:user]` passed directly to `User.update`** — flag block-severity, mass assignment. Use strong parameters: `params.require(:user).permit(:name, :email)`.
- **Skipping CSRF** (`skip_before_action :verify_authenticity_token`) without an API mode declaration — flag block-severity.
- **`render plain: params[:msg]`** without escaping — flag if the response is HTML (XSS).
- **`redirect_to params[:return_to]`** — flag, open redirect. Validate against an allowlist or a same-origin check.

## Views

- **`raw(...)`, `html_safe`, `<%= ... %>` with user input not escaped** — flag block-severity, XSS.
- **`link_to` with a non-literal URL from user input** — flag, XSS via `javascript:` schemes. Validate the scheme.
- **`session[:user_id]` set without `reset_session` after login** — flag, session fixation.

## Auth & security

- **Devise / `has_secure_password`** — fine. Flag custom password hashing with `Digest::SHA1` etc. (block-severity).
- **`secrets.yml` / `credentials.yml.enc` referenced in code** with non-Rails-managed secrets — flag, suggest Rails credentials.
- **Long-lived session cookies without `secure: true, httponly: true, same_site: :lax`** — flag.

## Background jobs

- **ActiveJob arguments that are ActiveRecord objects** — flag, will be GlobalID-serialized; if the record is deleted before the job runs the job will fail. Suggest passing the id and re-fetching.
- **Job that takes more than 30s** — flag with severity medium, suggest splitting.

## Routes

- **`match '/foo' => 'pages#foo'`** without `via:` — flag, matches all HTTP verbs (including DELETE). Use `get` / `post` / etc.

## Sources

- Rails security guide.
- `rubocop-rails`, `brakeman`.
