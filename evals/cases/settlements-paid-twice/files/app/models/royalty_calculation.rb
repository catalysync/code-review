class RoyaltyCalculation < ApplicationRecord
  belongs_to :contract
  belongs_to :royalty_payment, optional: true

  scope :paid, -> { where.not(royalty_payment_id: nil) }
  scope :unpaid, -> { where(royalty_payment_id: nil) }

  # Settlements imported from the old system were paid out there before the
  # contract moved to Boksmart. They are kept for the history and the
  # statement, never paid again, so they stay unpaid here on purpose.
  scope :historical_settlement, -> { where(source: 'historical_settlement') }
  scope :payable, -> { unpaid.where.not(source: 'historical_settlement') }
end
