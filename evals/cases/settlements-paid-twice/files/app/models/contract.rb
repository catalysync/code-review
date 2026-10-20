class Contract < ApplicationRecord
  has_many :royalty_calculations, dependent: :destroy
  has_many :royalty_payments, dependent: :destroy

  def sum_royalties_paid
    royalty_calculations.paid.sum(:royalty_cents)
  end

  # What the next payment would pay out.
  def sum_royalties_not_paid
    royalty_calculations.unpaid.sum(:royalty_cents)
  end
end
