ActiveRecord::Schema[8.0].define(version: 2026_10_01_000000) do
  create_table "contracts", force: :cascade do |t|
    t.string "name", null: false
    t.boolean "calculating", default: false, null: false
    t.date "active_from", null: false
  end
end
