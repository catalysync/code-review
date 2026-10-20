module Contracts
  # Frees a contract whose calculation can't run, so it can be started again.
  class Release
    def self.call(contract)
      return false unless contract.calculating?

      contract.update_column(:calculating, false)
      true
    end
  end
end
