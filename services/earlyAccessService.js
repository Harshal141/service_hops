const supabase = require('../config/supabase');

const TABLE_NAME = 'early_access';

const create = async (data) => {
  const { data: result, error } = await supabase
    .from(TABLE_NAME)
    .insert([data])
    .select()
    .single();

  if (error) throw error;
  return result;
};

module.exports = {
  create
};
