class RightsSalesController < ApplicationController
  def create
    @rights_sale = current_organization.rights_sales.new(rights_sale_params)
    if @rights_sale.save
      redirect_to rights_sales_path, notice: t('.created')
    else
      render :new, status: :unprocessable_entity
    end
  end

  private

  def rights_sale_params
    params.require(:rights_sale).permit(:book_id, :buyer, :amount, :sold_on)
  end
end
