class RightsSale < ApplicationRecord
  RIGHTS_TYPES = %w[translation audio film].freeze

  belongs_to :book
  validates :buyer, :amount, :sold_on, presence: true
  validates :rights_type, inclusion: { in: RIGHTS_TYPES }
end
